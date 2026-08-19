package com.accessibility.platform.target.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Slf4j
@Service
public class FaviconService {

    private static final int MAX_REDIRECTS = 4;
    private static final int MAX_HTML_BYTES = 256 * 1024;
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);
    private static final Pattern LINK_TAG_PATTERN = Pattern.compile("<link\\b[^>]*>", Pattern.CASE_INSENSITIVE);
    private static final Pattern ATTRIBUTE_PATTERN = Pattern.compile(
            "([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern CHARSET_PATTERN = Pattern.compile(
            "charset\\s*=\\s*[\"']?([^\\s;\"']+)",
            Pattern.CASE_INSENSITIVE
    );

    private final HttpClient httpClient;

    public FaviconService() {
        this(HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(3))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build());
    }

    FaviconService(HttpClient httpClient) {
        this.httpClient = httpClient;
    }

    /**
     * Reads a public web page and resolves its declared favicon URL.
     * Failure is deliberately non-fatal because a favicon is optional metadata.
     */
    public Optional<String> findFaviconUrl(String pageUrl) {
        URI initialUri = parseHttpUri(pageUrl).orElse(null);
        if (initialUri == null || !isPublicHttpUri(initialUri)) {
            return Optional.empty();
        }

        try {
            HtmlPage page = fetchHtml(initialUri);
            if (page == null) {
                return Optional.empty();
            }

            URI faviconUri = extractFaviconUri(page.uri(), page.html());
            if (faviconUri == null || !isPublicHttpUri(faviconUri)) {
                return Optional.empty();
            }
            return Optional.of(withoutFragment(faviconUri).toASCIIString());
        } catch (IOException e) {
            log.debug("Could not fetch favicon metadata from {}: {}", pageUrl, e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.debug("Favicon lookup was interrupted for {}", pageUrl);
        } catch (RuntimeException e) {
            log.debug("Could not resolve favicon for {}: {}", pageUrl, e.getMessage());
        }
        return Optional.empty();
    }

    URI extractFaviconUri(URI pageUri, String html) {
        List<FaviconCandidate> candidates = new ArrayList<>();
        Matcher linkMatcher = LINK_TAG_PATTERN.matcher(html);

        while (linkMatcher.find()) {
            Map<String, String> attributes = parseAttributes(linkMatcher.group());
            String rel = attributes.getOrDefault("rel", "").toLowerCase(Locale.ROOT);
            String href = attributes.get("href");
            int priority = priority(rel);

            if (priority >= 0 && href != null && !href.isBlank()) {
                resolveHttpUri(pageUri, href).ifPresent(uri ->
                        candidates.add(new FaviconCandidate(uri, priority, candidates.size()))
                );
            }
        }

        return candidates.stream()
                .min(Comparator.comparingInt(FaviconCandidate::priority)
                        .thenComparingInt(FaviconCandidate::order))
                .map(FaviconCandidate::uri)
                .orElseGet(() -> defaultFaviconUri(pageUri));
    }

    boolean isPublicHttpUri(URI uri) {
        if (uri == null
                || uri.getHost() == null
                || uri.getRawUserInfo() != null
                || !isHttpScheme(uri.getScheme())) {
            return false;
        }

        try {
            InetAddress[] addresses = InetAddress.getAllByName(uri.getHost());
            if (addresses.length == 0) {
                return false;
            }
            for (InetAddress address : addresses) {
                if (!isPublicAddress(address)) {
                    return false;
                }
            }
            return true;
        } catch (UnknownHostException e) {
            return false;
        }
    }

    private HtmlPage fetchHtml(URI initialUri) throws IOException, InterruptedException {
        URI currentUri = initialUri;

        for (int redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
            if (!isPublicHttpUri(currentUri)) {
                return null;
            }

            HttpRequest request = HttpRequest.newBuilder(currentUri)
                    .timeout(REQUEST_TIMEOUT)
                    .header("Accept", "text/html,application/xhtml+xml")
                    .header("User-Agent", "Accessibility-Dashboard/1.0 favicon-fetcher")
                    .GET()
                    .build();

            HttpResponse<InputStream> response = httpClient.send(
                    request,
                    HttpResponse.BodyHandlers.ofInputStream()
            );

            try (InputStream body = response.body()) {
                if (isRedirect(response.statusCode())) {
                    String location = response.headers().firstValue("Location").orElse(null);
                    if (location == null || redirectCount == MAX_REDIRECTS) {
                        return null;
                    }
                    currentUri = currentUri.resolve(location);
                    continue;
                }

                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    return null;
                }

                String contentType = response.headers().firstValue("Content-Type").orElse("");
                if (!contentType.isBlank()
                        && !contentType.toLowerCase(Locale.ROOT).contains("text/html")
                        && !contentType.toLowerCase(Locale.ROOT).contains("application/xhtml+xml")) {
                    return null;
                }

                byte[] bytes = body.readNBytes(MAX_HTML_BYTES + 1);
                if (bytes.length > MAX_HTML_BYTES) {
                    byte[] truncated = new byte[MAX_HTML_BYTES];
                    System.arraycopy(bytes, 0, truncated, 0, MAX_HTML_BYTES);
                    bytes = truncated;
                }
                return new HtmlPage(currentUri, new String(bytes, charset(contentType)));
            }
        }
        return null;
    }

    private Optional<URI> parseHttpUri(String value) {
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        try {
            URI uri = new URI(value.trim());
            return isHttpScheme(uri.getScheme()) ? Optional.of(uri) : Optional.empty();
        } catch (URISyntaxException e) {
            return Optional.empty();
        }
    }

    private Optional<URI> resolveHttpUri(URI pageUri, String href) {
        try {
            URI resolved = pageUri.resolve(href.trim());
            return isHttpScheme(resolved.getScheme()) && resolved.getHost() != null
                    ? Optional.of(resolved)
                    : Optional.empty();
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    private Map<String, String> parseAttributes(String tag) {
        Map<String, String> attributes = new HashMap<>();
        Matcher matcher = ATTRIBUTE_PATTERN.matcher(tag);
        while (matcher.find()) {
            String value = matcher.group(2) != null ? matcher.group(2)
                    : matcher.group(3) != null ? matcher.group(3)
                    : matcher.group(4);
            attributes.put(matcher.group(1).toLowerCase(Locale.ROOT), value);
        }
        return attributes;
    }

    private int priority(String rel) {
        List<String> tokens = List.of(rel.trim().split("\\s+"));
        if (tokens.contains("icon")) {
            return 0;
        }
        if (tokens.contains("apple-touch-icon") || tokens.contains("apple-touch-icon-precomposed")) {
            return 1;
        }
        return -1;
    }

    private URI defaultFaviconUri(URI pageUri) {
        try {
            return new URI(
                    pageUri.getScheme(),
                    null,
                    pageUri.getHost(),
                    pageUri.getPort(),
                    "/favicon.ico",
                    null,
                    null
            );
        } catch (URISyntaxException e) {
            return null;
        }
    }

    private URI withoutFragment(URI uri) {
        try {
            return new URI(
                    uri.getScheme(),
                    uri.getRawUserInfo(),
                    uri.getHost(),
                    uri.getPort(),
                    uri.getRawPath(),
                    uri.getRawQuery(),
                    null
            );
        } catch (URISyntaxException e) {
            return uri;
        }
    }

    private Charset charset(String contentType) {
        Matcher matcher = CHARSET_PATTERN.matcher(contentType);
        if (matcher.find()) {
            try {
                return Charset.forName(matcher.group(1));
            } catch (IllegalArgumentException ignored) {
                // Fall through to UTF-8.
            }
        }
        return StandardCharsets.UTF_8;
    }

    private boolean isRedirect(int statusCode) {
        return statusCode == 301
                || statusCode == 302
                || statusCode == 303
                || statusCode == 307
                || statusCode == 308;
    }

    private boolean isHttpScheme(String scheme) {
        return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
    }

    private boolean isPublicAddress(InetAddress address) {
        if (address.isAnyLocalAddress()
                || address.isLoopbackAddress()
                || address.isLinkLocalAddress()
                || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return false;
        }

        byte[] bytes = address.getAddress();
        if (address instanceof Inet4Address) {
            int first = Byte.toUnsignedInt(bytes[0]);
            int second = Byte.toUnsignedInt(bytes[1]);
            int third = Byte.toUnsignedInt(bytes[2]);

            return first != 0
                    && !(first == 100 && second >= 64 && second <= 127)
                    && !(first == 192 && second == 0 && (third == 0 || third == 2))
                    && !(first == 198 && (second == 18 || second == 19))
                    && !(first == 198 && second == 51 && third == 100)
                    && !(first == 203 && second == 0 && third == 113)
                    && first < 240;
        }

        if (address instanceof Inet6Address) {
            int first = Byte.toUnsignedInt(bytes[0]);
            return (first & 0xfe) != 0xfc;
        }
        return false;
    }

    private record HtmlPage(URI uri, String html) {
    }

    private record FaviconCandidate(URI uri, int priority, int order) {
    }
}
