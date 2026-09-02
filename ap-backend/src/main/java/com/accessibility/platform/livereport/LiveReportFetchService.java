package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import lombok.RequiredArgsConstructor;
import org.apache.hc.core5.http.ContentTooLongException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class LiveReportFetchService {
    private final LiveReportUpstreamClient upstreamClient;
    private final LiveReportProperties properties;
    private final LiveReportUrlSafetyValidator urlSafetyValidator;
    private final LiveReportSessionService sessionService;

    public FetchedResource fetch(
            LiveReportSessionService.LiveReportSession session,
            URI initialUri,
            URI initialReferrer
    ) {
        return fetch(session, initialUri, initialReferrer, LiveReportRequestHeaders.defaults());
    }

    public FetchedResource fetch(
            LiveReportSessionService.LiveReportSession session,
            URI initialUri,
            URI initialReferrer,
            LiveReportRequestHeaders browserHeaders
    ) {
        return fetch(session, initialUri, initialReferrer, browserHeaders, ProxyRequest.get(), null);
    }

    public FetchedResource fetchHead(
            LiveReportSessionService.LiveReportSession session,
            URI initialUri,
            URI initialReferrer,
            LiveReportRequestHeaders browserHeaders
    ) {
        return fetch(session, initialUri, initialReferrer, browserHeaders, ProxyRequest.head(), null);
    }

    public FetchedResource fetchPost(
            LiveReportSessionService.LiveReportSession session,
            URI initialUri,
            URI initialReferrer,
            LiveReportRequestHeaders browserHeaders,
            String contentType,
            byte[] body
    ) {
        URI documentUri = sessionService.documentUri(session).orElseThrow(() -> new LiveReportException(
                HttpStatus.CONFLICT,
                "Live report document is not ready for POST requests"
        ));
        return fetchPost(
                session,
                initialUri,
                initialReferrer,
                browserHeaders,
                documentUri,
                contentType,
                body
        );
    }

    public FetchedResource fetchPost(
            LiveReportSessionService.LiveReportSession session,
            URI initialUri,
            URI initialReferrer,
            LiveReportRequestHeaders browserHeaders,
            URI requestOrigin,
            String contentType,
            byte[] body
    ) {
        byte[] requestBody = body == null ? new byte[0] : body.clone();
        if (requestBody.length > Math.max(0, properties.getMaxRequestBodyBytes())) {
            throw new LiveReportException(
                    HttpStatus.CONTENT_TOO_LARGE,
                    "Live report request exceeds the configured size limit"
            );
        }
        String safeContentType = normalizeRequestContentType(contentType);
        if (requestOrigin == null || !sameOrigin(requestOrigin, initialUri)) {
            throw new LiveReportException(
                    HttpStatus.FORBIDDEN,
                    "Live report POST requests must remain on the document origin"
            );
        }
        return fetch(
                session,
                initialUri,
                initialReferrer,
                browserHeaders,
                ProxyRequest.post(safeContentType, requestBody),
                requestOrigin
        );
    }

    public FetchedResource fetchPreflight(
            LiveReportSessionService.LiveReportSession session,
            URI targetUri,
            LiveReportRequestHeaders browserHeaders,
            String requestedMethod,
            String requestedHeaders
    ) {
        LiveReportRequestHeaders safeHeaders = browserHeaders == null
                ? LiveReportRequestHeaders.defaults()
                : browserHeaders;
        if (safeHeaders.upstreamOrigin() == null) {
            throw new LiveReportException(HttpStatus.FORBIDDEN, "Live report preflight Origin is invalid");
        }
        String method = normalizePreflightMethod(requestedMethod);
        String headers = normalizePreflightHeaders(requestedHeaders);
        return fetch(
                session,
                targetUri,
                null,
                safeHeaders,
                ProxyRequest.options(method, headers),
                null
        );
    }

    private FetchedResource fetch(
            LiveReportSessionService.LiveReportSession session,
            URI initialUri,
            URI initialReferrer,
            LiveReportRequestHeaders browserHeaders,
            ProxyRequest initialRequest,
            URI restrictedPostOrigin
    ) {
        URI currentUri = initialUri;
        URI requestReferrer = initialReferrer;
        LiveReportRequestHeaders safeBrowserHeaders = browserHeaders == null
                ? LiveReportRequestHeaders.defaults()
                : browserHeaders;
        URI upstreamSourceOrigin = parseUpstreamSourceOrigin(safeBrowserHeaders.upstreamOrigin());
        boolean corsCrossOrigin = false;
        boolean corsAllowed = true;
        ProxyRequest currentRequest = initialRequest;

        try {
            for (int redirectCount = 0; redirectCount <= properties.getMaxRedirects(); redirectCount++) {
                LiveReportUrlSafetyValidator.ValidatedUrl validated = urlSafetyValidator.validate(currentUri);
                if (restrictedPostOrigin != null && !sameOrigin(restrictedPostOrigin, validated.uri())) {
                    throw new LiveReportException(
                            HttpStatus.FORBIDDEN,
                            "Live report POST redirect left the document origin"
                    );
                }
                HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(validated.uri())
                        .timeout(Duration.ofSeconds(properties.getRequestTimeoutSeconds()))
                        .header("Accept", safeBrowserHeaders.accept())
                        .header("Accept-Language", safeBrowserHeaders.acceptLanguage())
                        .header("User-Agent", safeBrowserHeaders.userAgent());
                if (upstreamSourceOrigin != null) {
                    requestBuilder.header("Origin", upstreamSourceOrigin.toASCIIString());
                }
                if (currentRequest.isPost()) {
                    if (currentRequest.contentType() != null) {
                        requestBuilder.header("Content-Type", currentRequest.contentType());
                    }
                    requestBuilder.POST(BodyPublishers.ofByteArray(currentRequest.body()));
                } else if (currentRequest.isOptions()) {
                    requestBuilder.header("Access-Control-Request-Method", currentRequest.preflightMethod());
                    if (currentRequest.preflightHeaders() != null) {
                        requestBuilder.header("Access-Control-Request-Headers", currentRequest.preflightHeaders());
                    }
                    requestBuilder.method("OPTIONS", BodyPublishers.noBody());
                } else if (currentRequest.isHead()) {
                    requestBuilder.method("HEAD", BodyPublishers.noBody());
                } else {
                    requestBuilder.GET();
                }
                boolean crossOriginRequest = upstreamSourceOrigin != null
                        && !sameOrigin(upstreamSourceOrigin, validated.uri());
                // The replay bridge deliberately uses credentials:'omit'. Mirror that
                // browser behavior upstream: a CORS request must neither consume nor
                // populate the server-side cookie jar for the target origin.
                if (!crossOriginRequest && !currentRequest.isOptions()) {
                    sessionService.cookieHeader(session, validated.uri())
                            .ifPresent(cookie -> requestBuilder.header("Cookie", cookie));
                }
                safeReferrer(requestReferrer, validated.uri())
                        .ifPresent(referrer -> requestBuilder.header("Referer", referrer));

                HttpRequest request = requestBuilder.build();
                if (currentRequest.isPost()) {
                    // Charge every actual transmission. A 307/308 replay must not
                    // multiply upload traffic outside the per-session byte budget.
                    sessionService.recordResponseBytes(session, currentRequest.body().length);
                }
                LiveReportUpstreamClient.UpstreamResponse response = currentRequest.isPost()
                        ? upstreamClient.send(request, validated.resolvedAddresses(), currentRequest.body())
                        : upstreamClient.send(request, validated.resolvedAddresses());
                if (!crossOriginRequest && !currentRequest.isOptions()) {
                    sessionService.storeResponseCookies(
                            session,
                            validated.uri(),
                            response.allValues("Set-Cookie")
                    );
                }
                if (crossOriginRequest) {
                    corsCrossOrigin = true;
                    corsAllowed = corsAllowed && upstreamAllowsCors(response, upstreamSourceOrigin);
                    if (currentRequest.isOptions()) {
                        corsAllowed = corsAllowed
                                && response.statusCode() >= 200
                                && response.statusCode() < 300
                                && upstreamAllowsPreflight(
                                response,
                                currentRequest.preflightMethod(),
                                currentRequest.preflightHeaders()
                        );
                    }
                    if (!corsAllowed && isRedirect(response.statusCode())) {
                        throw new LiveReportException(
                                HttpStatus.FORBIDDEN,
                                "Live report upstream CORS policy denied the redirect"
                        );
                    }
                }
                if (isRedirect(response.statusCode())) {
                    if (currentRequest.isOptions()) {
                        throw new LiveReportException(
                                HttpStatus.FORBIDDEN,
                                "Live report upstream CORS preflight redirected"
                        );
                    }
                    if (redirectCount == properties.getMaxRedirects()) {
                        throw new LiveReportException(HttpStatus.BAD_GATEWAY, "Live report redirect limit was exceeded");
                    }
                    String location = response.firstValue("Location")
                            .orElseThrow(() -> new LiveReportException(
                                    HttpStatus.BAD_GATEWAY,
                                    "Live report redirect did not include a Location header"
                            ));
                    URI redirectUri;
                    try {
                        redirectUri = validated.uri().resolve(location);
                        if (restrictedPostOrigin != null && !sameOrigin(restrictedPostOrigin, redirectUri)) {
                            throw new LiveReportException(
                                    HttpStatus.FORBIDDEN,
                                    "Live report POST redirect left the document origin"
                            );
                        }
                        requestReferrer = validated.uri();
                        currentUri = urlSafetyValidator.validate(redirectUri).uri();
                        if (currentRequest.isPost()
                                && (response.statusCode() == 301
                                || response.statusCode() == 302
                                || response.statusCode() == 303)) {
                            currentRequest = ProxyRequest.get();
                        }
                    } catch (IllegalArgumentException e) {
                        throw new LiveReportException(
                                HttpStatus.BAD_GATEWAY,
                                "Live report redirect target was blocked",
                                e
                        );
                    }
                    continue;
                }

                Optional<String> declaredContentType = response.firstValue("Content-Type");
                String contentType = declaredContentType.orElse("application/octet-stream");
                int responseLimit = properties.responseLimitBytes(declaredContentType.orElse(""));
                long declaredLength = contentLength(response);
                if (!currentRequest.isHead() && declaredLength > responseLimit) {
                    throw tooLarge();
                }

                byte[] bytes = currentRequest.isHead() ? new byte[0] : response.body();
                if (bytes.length > responseLimit) {
                    throw tooLarge();
                }

                return new FetchedResource(
                        response.statusCode(),
                        validated.uri(),
                        normalizeContentType(contentType),
                        bytes,
                        new CorsEvidence(
                                upstreamSourceOrigin != null,
                                corsCrossOrigin,
                                corsAllowed
                        )
                );
            }
        } catch (LiveReportException e) {
            throw e;
        } catch (IllegalArgumentException e) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (ContentTooLongException e) {
            throw tooLarge();
        } catch (IOException e) {
            throw new LiveReportException(HttpStatus.BAD_GATEWAY, "Live report upstream could not be fetched", e);
        }

        throw new LiveReportException(HttpStatus.BAD_GATEWAY, "Live report upstream could not be fetched");
    }

    private LiveReportException tooLarge() {
        return new LiveReportException(HttpStatus.CONTENT_TOO_LARGE, "Live report response exceeds the configured size limit");
    }

    private String normalizeRequestContentType(String contentType) {
        if (contentType == null || contentType.isBlank()) {
            return null;
        }
        String normalized = contentType.trim();
        if (normalized.length() > 200 || normalized.contains("\r") || normalized.contains("\n")) {
            throw unsupportedRequestType();
        }
        final MediaType parsed;
        try {
            parsed = MediaType.parseMediaType(normalized);
        } catch (IllegalArgumentException exception) {
            throw unsupportedRequestType();
        }
        if ("multipart".equalsIgnoreCase(parsed.getType())) {
            throw unsupportedRequestType();
        }
        return normalized;
    }

    private LiveReportException unsupportedRequestType() {
        return new LiveReportException(
                HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                "Live report POST content type is not allowed"
        );
    }

    private String normalizePreflightMethod(String rawMethod) {
        String method = rawMethod == null ? "" : rawMethod.trim().toUpperCase(Locale.ROOT);
        if (!method.equals("GET") && !method.equals("HEAD") && !method.equals("POST")) {
            throw new LiveReportException(
                    HttpStatus.FORBIDDEN,
                    "Live report preflight method is not allowed"
            );
        }
        return method;
    }

    private String normalizePreflightHeaders(String rawHeaders) {
        if (rawHeaders == null || rawHeaders.isBlank()) {
            return null;
        }
        if (rawHeaders.length() > 2048 || rawHeaders.chars().anyMatch(character -> character < 0x20)) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, "Live report preflight headers are invalid");
        }
        var normalized = java.util.Arrays.stream(rawHeaders.split(","))
                .map(String::trim)
                .map(value -> value.toLowerCase(Locale.ROOT))
                .filter(value -> !value.equals(LiveReportTransport.HEADER_NAME.toLowerCase(Locale.ROOT)))
                .toList();
        if (normalized.stream().anyMatch(value -> value.isEmpty()
                || !value.matches("[!#$%&'*+.^_`|~0-9a-z-]+"))) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, "Live report preflight headers are invalid");
        }
        // The live proxy currently forwards only the non-safelisted Content-Type
        // request header. Do not claim support for headers that would be dropped.
        if (normalized.stream().anyMatch(value -> !value.equals("content-type"))) {
            throw new LiveReportException(HttpStatus.FORBIDDEN, "Live report preflight header is not supported");
        }
        return normalized.isEmpty() ? null : String.join(", ", normalized.stream().distinct().toList());
    }

    private URI parseUpstreamSourceOrigin(String rawOrigin) {
        if (rawOrigin == null) {
            return null;
        }
        try {
            URI origin = URI.create(rawOrigin);
            String path = origin.getRawPath();
            if (!origin.isAbsolute()
                    || !"https".equalsIgnoreCase(origin.getScheme())
                    || origin.getHost() == null
                    || origin.getRawUserInfo() != null
                    || origin.getRawQuery() != null
                    || origin.getRawFragment() != null
                    || (path != null && !path.isEmpty())
                    || (origin.getPort() != -1 && origin.getPort() != 443)) {
                throw new IllegalArgumentException("invalid origin");
            }
            String host = origin.getHost().toLowerCase(Locale.ROOT);
            String authority = host.indexOf(':') >= 0 ? "[" + host + "]" : host;
            return URI.create("https://" + authority
                    + (origin.getPort() == -1 || origin.getPort() == 443
                    ? ""
                    : ":" + origin.getPort()));
        } catch (IllegalArgumentException exception) {
            throw new LiveReportException(
                    HttpStatus.BAD_REQUEST,
                    "Live report upstream Origin is invalid",
                    exception
            );
        }
    }

    private boolean upstreamAllowsCors(
            LiveReportUpstreamClient.UpstreamResponse response,
            URI sourceOrigin
    ) {
        var values = response.allValues("Access-Control-Allow-Origin");
        if (values.size() != 1) {
            return false;
        }
        String allowed = values.get(0).trim();
        if ("*".equals(allowed)) {
            return true;
        }
        if (allowed.isEmpty() || allowed.indexOf(',') >= 0) {
            return false;
        }
        try {
            URI allowedOrigin = URI.create(allowed);
            String path = allowedOrigin.getRawPath();
            return allowedOrigin.isAbsolute()
                    && allowedOrigin.getRawUserInfo() == null
                    && allowedOrigin.getRawQuery() == null
                    && allowedOrigin.getRawFragment() == null
                    && (path == null || path.isEmpty())
                    && sameOrigin(sourceOrigin, allowedOrigin);
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private boolean upstreamAllowsPreflight(
            LiveReportUpstreamClient.UpstreamResponse response,
            String requestedMethod,
            String requestedHeaders
    ) {
        boolean methodAllowed = headerTokens(response, "Access-Control-Allow-Methods").stream()
                .anyMatch(value -> value.equalsIgnoreCase(requestedMethod));
        if (!methodAllowed) {
            return false;
        }
        if (requestedHeaders == null) {
            return true;
        }
        var allowedHeaders = headerTokens(response, "Access-Control-Allow-Headers");
        return java.util.Arrays.stream(requestedHeaders.split(","))
                .map(String::trim)
                .allMatch(requested -> allowedHeaders.stream()
                        .anyMatch(allowed -> allowed.equals("*") || allowed.equalsIgnoreCase(requested)));
    }

    private java.util.List<String> headerTokens(
            LiveReportUpstreamClient.UpstreamResponse response,
            String headerName
    ) {
        return response.allValues(headerName).stream()
                .flatMap(value -> java.util.Arrays.stream(value.split(",")))
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .toList();
    }

    private long contentLength(LiveReportUpstreamClient.UpstreamResponse response) {
        return response.firstValue("Content-Length")
                .flatMap(value -> {
                    try {
                        long parsed = Long.parseLong(value.trim());
                        return parsed >= 0 ? Optional.of(parsed) : Optional.empty();
                    } catch (NumberFormatException ignored) {
                        return Optional.empty();
                    }
                })
                .orElse(-1L);
    }

    private Optional<String> safeReferrer(URI source, URI destination) {
        if (source == null
                || !"https".equalsIgnoreCase(source.getScheme())
                || source.getHost() == null
                || !"https".equalsIgnoreCase(destination.getScheme())
                || destination.getHost() == null) {
            return Optional.empty();
        }
        try {
            boolean sameOrigin = source.getHost().equalsIgnoreCase(destination.getHost())
                    && effectivePort(source) == effectivePort(destination);
            URI referrer = new URI(
                    "https",
                    null,
                    source.getHost(),
                    source.getPort(),
                    sameOrigin && source.getRawPath() != null && !source.getRawPath().isEmpty()
                            ? source.getRawPath()
                            : "/",
                    sameOrigin ? source.getRawQuery() : null,
                    null
            );
            return Optional.of(referrer.toASCIIString());
        } catch (Exception ignored) {
            return Optional.empty();
        }
    }

    private int effectivePort(URI uri) {
        if (uri.getPort() >= 0) {
            return uri.getPort();
        }
        return "http".equalsIgnoreCase(uri.getScheme()) ? 80 : 443;
    }

    private boolean sameOrigin(URI first, URI second) {
        return first != null
                && second != null
                && first.getScheme() != null
                && second.getScheme() != null
                && first.getHost() != null
                && second.getHost() != null
                && first.getScheme().equalsIgnoreCase(second.getScheme())
                && first.getHost().equalsIgnoreCase(second.getHost())
                && effectivePort(first) == effectivePort(second);
    }

    private boolean isRedirect(int statusCode) {
        return statusCode == 301
                || statusCode == 302
                || statusCode == 303
                || statusCode == 307
                || statusCode == 308;
    }

    private String normalizeContentType(String contentType) {
        String normalized = contentType.trim();
        if (normalized.isBlank() || normalized.length() > 200 || normalized.contains("\r") || normalized.contains("\n")) {
            return "application/octet-stream";
        }
        // Preserve the upstream declaration exactly. HTML decoding still needs to
        // consult BOM/meta declarations when the transport omitted a charset; the
        // controller emits the rewritten document itself as UTF-8 afterwards.
        return normalized;
    }

    private record ProxyRequest(
            String method,
            String contentType,
            byte[] body,
            String preflightMethod,
            String preflightHeaders
    ) {
        private ProxyRequest {
            body = body == null ? new byte[0] : body.clone();
        }

        static ProxyRequest get() {
            return new ProxyRequest("GET", null, new byte[0], null, null);
        }

        static ProxyRequest head() {
            return new ProxyRequest("HEAD", null, new byte[0], null, null);
        }

        static ProxyRequest post(String contentType, byte[] body) {
            return new ProxyRequest("POST", contentType, body, null, null);
        }

        static ProxyRequest options(String requestedMethod, String requestedHeaders) {
            return new ProxyRequest("OPTIONS", null, new byte[0], requestedMethod, requestedHeaders);
        }

        boolean isPost() {
            return "POST".equals(method);
        }

        boolean isHead() {
            return "HEAD".equals(method);
        }

        boolean isOptions() {
            return "OPTIONS".equals(method);
        }

        @Override
        public byte[] body() {
            return body.clone();
        }
    }

    public record FetchedResource(
            int statusCode,
            URI finalUri,
            String contentType,
            byte[] bytes,
            CorsEvidence cors
    ) {
        public FetchedResource(URI finalUri, String contentType, byte[] bytes) {
            this(200, finalUri, contentType, bytes, CorsEvidence.none());
        }

        public FetchedResource(int statusCode, URI finalUri, String contentType, byte[] bytes) {
            this(statusCode, finalUri, contentType, bytes, CorsEvidence.none());
        }

        public FetchedResource {
            bytes = bytes == null ? new byte[0] : bytes.clone();
            cors = cors == null ? CorsEvidence.none() : cors;
        }

        public boolean isHtml() {
            String lower = contentType.toLowerCase(Locale.ROOT);
            return lower.startsWith("text/html") || lower.startsWith("application/xhtml+xml");
        }

        public boolean isCss() {
            return contentType.toLowerCase(Locale.ROOT).startsWith("text/css");
        }

        public boolean isJavaScript() {
            String lower = contentType.toLowerCase(Locale.ROOT);
            return lower.startsWith("text/javascript")
                    || lower.startsWith("application/javascript")
                    || lower.startsWith("text/ecmascript")
                    || lower.startsWith("application/ecmascript")
                    || lower.startsWith("application/x-javascript")
                    || lower.startsWith("text/x-javascript");
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }

    public record CorsEvidence(boolean originSupplied, boolean crossOrigin, boolean allowed) {
        static CorsEvidence none() {
            return new CorsEvidence(false, false, false);
        }
    }
}
