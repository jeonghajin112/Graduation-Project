package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import org.apache.hc.client5.http.DnsResolver;
import org.apache.hc.client5.http.classic.methods.HttpGet;
import org.apache.hc.client5.http.classic.methods.HttpHead;
import org.apache.hc.client5.http.classic.methods.HttpOptions;
import org.apache.hc.client5.http.classic.methods.HttpPost;
import org.apache.hc.client5.http.classic.methods.HttpUriRequestBase;
import org.apache.hc.client5.http.config.ConnectionConfig;
import org.apache.hc.client5.http.config.RequestConfig;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManager;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManagerBuilder;
import org.apache.hc.core5.http.Header;
import org.apache.hc.core5.http.HttpEntity;
import org.apache.hc.core5.http.ContentType;
import org.apache.hc.core5.http.io.entity.EntityUtils;
import org.apache.hc.core5.http.io.entity.ByteArrayEntity;
import org.apache.hc.core5.util.Timeout;
import org.apache.hc.core5.util.TimeValue;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.IDN;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.net.http.HttpRequest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Comparator;

/**
 * Executes one upstream request against exactly the DNS answers that were
 * approved by {@link LiveReportUrlSafetyValidator}.
 *
 * <p>The request URI retains its original hostname. Apache HttpClient therefore
 * sends that hostname as TLS SNI and applies its normal certificate hostname
 * verification, while {@link PinnedDnsResolver} prevents a second, racing DNS
 * lookup from selecting an unvalidated address.</p>
 */
@Component
@RequiredArgsConstructor
public class LiveReportUpstreamClient {
    private static final int MAX_PINNED_CLIENTS = 32;
    private final LiveReportProperties properties;
    private final Map<PinnedRoute, CloseableHttpClient> clients = new LinkedHashMap<>();

    public UpstreamResponse send(HttpRequest request, List<InetAddress> validatedAddresses) throws IOException {
        return send(request, validatedAddresses, new byte[0]);
    }

    public UpstreamResponse send(
            HttpRequest request,
            List<InetAddress> validatedAddresses,
            byte[] requestBody
    ) throws IOException {
        String expectedHost = canonicalHost(request.uri().getHost());
        PinnedRoute route = PinnedRoute.of(expectedHost, validatedAddresses);
        ClientLease lease = clientFor(route, validatedAddresses);

        HttpUriRequestBase upstreamRequest;
        if ("POST".equalsIgnoreCase(request.method())) {
            HttpPost post = new HttpPost(request.uri());
            post.setEntity(new ByteArrayEntity(
                    requestBody == null ? new byte[0] : requestBody,
                    (ContentType) null
            ));
            upstreamRequest = post;
        } else if ("OPTIONS".equalsIgnoreCase(request.method())) {
            upstreamRequest = new HttpOptions(request.uri());
        } else if ("HEAD".equalsIgnoreCase(request.method())) {
            upstreamRequest = new HttpHead(request.uri());
        } else if ("GET".equalsIgnoreCase(request.method())) {
            upstreamRequest = new HttpGet(request.uri());
        } else {
            throw new IllegalArgumentException("Unsupported live report upstream method");
        }
        request.headers().map().forEach((name, values) -> values.forEach(value -> upstreamRequest.addHeader(name, value)));

        try {
            return lease.client().execute(upstreamRequest, response -> {
                Map<String, List<String>> headers = copyHeaders(response.getHeaders());
                HttpEntity entity = response.getEntity();
                String contentType = headers.entrySet().stream()
                        .filter(entry -> entry.getKey().equalsIgnoreCase("Content-Type"))
                        .flatMap(entry -> entry.getValue().stream())
                        .findFirst()
                        .orElse("");
                int maximum = properties.responseLimitBytes(contentType);
                int readLimit = maximum == Integer.MAX_VALUE ? maximum : maximum + 1;
                byte[] body = "HEAD".equalsIgnoreCase(request.method())
                        || entity == null
                        || isRedirect(response.getCode())
                        ? new byte[0]
                        : EntityUtils.toByteArray(entity, readLimit);
                return new UpstreamResponse(response.getCode(), headers, body);
            });
        } finally {
            if (lease.closeAfterUse()) {
                lease.client().close();
            }
        }
    }

    private ClientLease clientFor(PinnedRoute route, List<InetAddress> validatedAddresses) {
        synchronized (clients) {
            CloseableHttpClient existing = clients.get(route);
            if (existing != null) {
                return new ClientLease(existing, false);
            }
            CloseableHttpClient created = createClient(route.host(), validatedAddresses);
            if (clients.size() >= MAX_PINNED_CLIENTS) {
                return new ClientLease(created, true);
            }
            clients.put(route, created);
            return new ClientLease(created, false);
        }
    }

    private CloseableHttpClient createClient(String expectedHost, List<InetAddress> validatedAddresses) {
        PinnedDnsResolver dnsResolver = new PinnedDnsResolver(expectedHost, validatedAddresses);
        Timeout connectTimeout = Timeout.ofSeconds(properties.getConnectTimeoutSeconds());
        Timeout responseTimeout = Timeout.ofSeconds(properties.getRequestTimeoutSeconds());
        ConnectionConfig connectionConfig = ConnectionConfig.custom()
                .setConnectTimeout(connectTimeout)
                .setSocketTimeout(responseTimeout)
                .setTimeToLive(TimeValue.ofMinutes(2))
                .build();
        PoolingHttpClientConnectionManager connectionManager = PoolingHttpClientConnectionManagerBuilder.create()
                .setDnsResolver(dnsResolver)
                .setDefaultConnectionConfig(connectionConfig)
                .setMaxConnPerRoute(Math.max(1, properties.getMaxConcurrentRequestsPerSession()))
                .setMaxConnTotal(Math.max(1, properties.getMaxConcurrentRequestsPerSession()))
                .build();
        RequestConfig requestConfig = RequestConfig.custom()
                .setConnectionRequestTimeout(connectTimeout)
                .setResponseTimeout(responseTimeout)
                .setRedirectsEnabled(false)
                .build();

        return HttpClients.custom()
                .setConnectionManager(connectionManager)
                .setDefaultRequestConfig(requestConfig)
                .disableRedirectHandling()
                .disableAutomaticRetries()
                .disableCookieManagement()
                .disableAuthCaching()
                .disableConnectionState()
                .disableDefaultUserAgent()
                .build();
    }

    @PreDestroy
    void closeClients() {
        synchronized (clients) {
            clients.values().forEach(client -> {
                try {
                    client.close();
                } catch (IOException ignored) {
                    // The application is already shutting down.
                }
            });
            clients.clear();
        }
    }

    private Map<String, List<String>> copyHeaders(Header[] sourceHeaders) {
        Map<String, List<String>> mutable = new LinkedHashMap<>();
        for (Header header : sourceHeaders) {
            mutable.computeIfAbsent(header.getName(), ignored -> new ArrayList<>()).add(header.getValue());
        }
        Map<String, List<String>> copied = new LinkedHashMap<>();
        mutable.forEach((name, values) -> copied.put(name, List.copyOf(values)));
        return Collections.unmodifiableMap(copied);
    }

    private static String canonicalHost(String host) {
        if (host == null || host.isBlank()) {
            throw new IllegalArgumentException("Pinned upstream host is required");
        }
        String value = host;
        if (value.startsWith("[") && value.endsWith("]")) {
            value = value.substring(1, value.length() - 1);
        }
        return IDN.toASCII(value, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
    }

    private boolean isRedirect(int statusCode) {
        return statusCode == 301
                || statusCode == 302
                || statusCode == 303
                || statusCode == 307
                || statusCode == 308;
    }

    static final class PinnedDnsResolver implements DnsResolver {
        private final String expectedHost;
        private final InetAddress[] addresses;

        PinnedDnsResolver(String expectedHost, List<InetAddress> addresses) {
            this.expectedHost = canonicalHost(expectedHost);
            if (addresses == null || addresses.isEmpty() || addresses.stream().anyMatch(java.util.Objects::isNull)) {
                throw new IllegalArgumentException("At least one validated upstream address is required");
            }
            this.addresses = addresses.toArray(InetAddress[]::new);
        }

        @Override
        public InetAddress[] resolve(String host) throws UnknownHostException {
            requireExpectedHost(host);
            return addresses.clone();
        }

        @Override
        public String resolveCanonicalHostname(String host) throws UnknownHostException {
            requireExpectedHost(host);
            return expectedHost;
        }

        private void requireExpectedHost(String host) throws UnknownHostException {
            final String canonical;
            try {
                canonical = canonicalHost(host);
            } catch (IllegalArgumentException exception) {
                throw new UnknownHostException("Unvalidated upstream host was requested");
            }
            if (!expectedHost.equals(canonical)) {
                throw new UnknownHostException("Unvalidated upstream host was requested");
            }
        }
    }

    private record ClientLease(CloseableHttpClient client, boolean closeAfterUse) {
    }

    private record PinnedRoute(String host, List<String> addresses) {
        static PinnedRoute of(String host, List<InetAddress> addresses) {
            if (addresses == null || addresses.isEmpty()) {
                throw new IllegalArgumentException("At least one validated upstream address is required");
            }
            List<String> addressKeys = addresses.stream()
                    .map(InetAddress::getHostAddress)
                    .sorted(Comparator.naturalOrder())
                    .toList();
            return new PinnedRoute(canonicalHost(host), addressKeys);
        }
    }

    public record UpstreamResponse(int statusCode, Map<String, List<String>> headers, byte[] body) {
        public UpstreamResponse {
            Map<String, List<String>> copiedHeaders = new LinkedHashMap<>();
            headers.forEach((name, values) -> copiedHeaders.put(name, List.copyOf(values)));
            headers = Collections.unmodifiableMap(copiedHeaders);
            body = body.clone();
        }

        public List<String> allValues(String name) {
            return headers.entrySet().stream()
                    .filter(entry -> entry.getKey().equalsIgnoreCase(name))
                    .flatMap(entry -> entry.getValue().stream())
                    .toList();
        }

        public Optional<String> firstValue(String name) {
            return allValues(name).stream().findFirst();
        }

        @Override
        public byte[] body() {
            return body.clone();
        }
    }
}
