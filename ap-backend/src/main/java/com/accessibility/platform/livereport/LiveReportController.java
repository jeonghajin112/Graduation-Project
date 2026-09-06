package com.accessibility.platform.livereport;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.livereport.config.LiveReportProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.UriComponentsBuilder;
import org.springframework.web.util.UriUtils;

import java.net.URI;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;

@RestController
@RequiredArgsConstructor
public class LiveReportController {
    private static final Logger log = LoggerFactory.getLogger(LiveReportController.class);
    static final String ERROR_HEADER = "X-Accessibility-Live-Error";
    static final String SESSION_BUDGET_EXCEEDED = "session-budget-exceeded";
    private static final String CURRENT_SESSION_ATTRIBUTE =
            LiveReportController.class.getName() + ".currentSession";

    private final LiveReportLaunchService launchService;
    private final LiveReportSessionService sessionService;
    private final LiveReportFetchService fetchService;
    private final LiveReportDocumentRewriter documentRewriter;
    private final LiveReportProperties properties;
    private final LiveReportOriginRouteRegistry originRoutes;

    @PostMapping("/api/results/requests/{requestId}/live-session")
    public ApiResponse<LiveReportSessionResponse> createSession(@PathVariable long requestId) {
        return sessionResponse(launchService.createForRequest(requestId));
    }

    @PostMapping("/api/results/requests/{requestId}/live-session/{sessionId}/renew")
    public ApiResponse<LiveReportSessionResponse> renewSession(
            @PathVariable long requestId,
            @PathVariable UUID sessionId
    ) {
        return sessionResponse(launchService.renewForRequest(requestId, sessionId));
    }

    private ApiResponse<LiveReportSessionResponse> sessionResponse(
            LiveReportSessionService.LiveReportSession session
    ) {
        LiveReportOriginRouteRegistry.RoutedOrigin initialRoute =
                originRoutes.routeFor(session, session.targetUri());
        String viewerOrigin = initialRoute.viewerOrigin().toASCIIString();
        String runtimeUrl = originRoutes.runtimeUrl(session, session.targetUri());
        return ApiResponse.ok(new LiveReportSessionResponse(
                session.id(),
                runtimeUrl,
                viewerOrigin,
                session.nonce(),
                session.bridgeSecret(),
                session.expiresAt()
        ));
    }

    /**
     * Private MVC target selected only by {@link LiveReportViewerRoutingFilter}. The browser-facing
     * replay URL keeps the upstream raw path in place; this internal path never appears in the
     * document and cannot collide with an upstream site's own {@code /api/**} routes.
     */
    @RequestMapping(
            path = "/__live-replay/{routeToken}",
            method = {RequestMethod.GET, RequestMethod.HEAD, RequestMethod.POST, RequestMethod.OPTIONS}
    )
    public ResponseEntity<byte[]> getViewerDocument(
            @PathVariable String routeToken,
            HttpServletRequest browserRequest
    ) {
        Object routedToken = browserRequest.getAttribute(
                LiveReportViewerRoutingFilter.ROUTE_TOKEN_ATTRIBUTE
        );
        Object rawPath = browserRequest.getAttribute(
                LiveReportViewerRoutingFilter.ORIGINAL_RAW_PATH_ATTRIBUTE
        );
        if (!(routedToken instanceof String token)
                || !(rawPath instanceof String upstreamRawPath)
                || !constantTimeEquals(routeToken, token)) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report viewer route was not found");
        }

        LiveReportOriginRouteRegistry.RoutedRequest routed = originRoutes.requireViewerRequest(
                browserRequest.getServerName(),
                upstreamRawPath,
                browserRequest.getQueryString()
        );
        LiveReportSessionService.LiveReportSession session = routed.session();
        browserRequest.setAttribute(CURRENT_SESSION_ATTRIBUTE, session);
        boolean postRequest = "POST".equalsIgnoreCase(browserRequest.getMethod());
        boolean headRequest = "HEAD".equalsIgnoreCase(browserRequest.getMethod());
        boolean preflightRequest = "OPTIONS".equalsIgnoreCase(browserRequest.getMethod());
        boolean programmaticRequest = LiveReportTransport.isProgrammatic(browserRequest);
        if (postRequest && !programmaticRequest) {
            throw new LiveReportException(
                    HttpStatus.FORBIDDEN,
                    "Live report POST requests require fetch or XMLHttpRequest"
            );
        }

        var existingDocumentUri = sessionService.documentUri(session);
        URI upstreamReferrer = existingDocumentUri.isEmpty()
                && routed.targetUri().equals(session.targetUri())
                ? null
                : resolveViewerUpstreamReferrer(routed, browserRequest);
        CorsRequestContext cors = resolveCorsRequest(session, browserRequest);
        if (preflightRequest) {
            return handlePreflight(session, routed.targetUri(), cors, browserRequest);
        }
        LiveReportRequestHeaders browserHeaders = requestHeaders(browserRequest, cors);
        LiveReportFetchService.FetchedResource fetched = postRequest
                ? fetchPostBudgeted(
                        session,
                        routed.targetUri(),
                        upstreamReferrer,
                        browserHeaders,
                        routed.upstreamOrigin(),
                        browserRequest
                )
                : headRequest
                ? fetchHeadBudgeted(
                        session,
                        routed.targetUri(),
                        upstreamReferrer,
                        browserHeaders
                )
                : fetchBudgeted(
                        session,
                        routed.targetUri(),
                        upstreamReferrer,
                        browserHeaders
                );

        String requestedViewerUrl = originRoutes.runtimeUrl(session, routed.targetUri());
        String finalViewerUrl = originRoutes.runtimeUrl(session, fetched.finalUri());
        if (!programmaticRequest && !requestedViewerUrl.equals(finalViewerUrl)) {
            return viewerRedirect(finalViewerUrl, fetched, cors);
        }
        ResponseEntity<byte[]> response = headRequest
                ? renderHeadResponse(fetched, session, cors)
                : programmaticRequest
                ? renderDynamicResponse(fetched, cors)
                : renderFetched(fetched, session, cors);
        if (!programmaticRequest
                && "GET".equalsIgnoreCase(browserRequest.getMethod())
                && fetched.isHtml()
                && existingDocumentUri.isEmpty()) {
            sessionService.recordDocumentUri(session, fetched.finalUri());
        }
        return response;
    }

    @GetMapping("/api/live-reports/{sessionId}/document")
    public ResponseEntity<byte[]> getDocument(
            @PathVariable UUID sessionId,
            @RequestParam String nonce,
            HttpServletRequest browserRequest
    ) {
        LiveReportSessionService.LiveReportSession session = sessionService.requireAuthorized(sessionId, nonce);
        browserRequest.setAttribute(CURRENT_SESSION_ATTRIBUTE, session);
        boolean headRequest = "HEAD".equalsIgnoreCase(browserRequest.getMethod());
        CorsRequestContext cors = resolveCorsRequest(session, browserRequest);
        LiveReportRequestHeaders browserHeaders = requestHeaders(browserRequest, cors);
        LiveReportFetchService.FetchedResource fetched = headRequest
                ? fetchHeadBudgeted(session, session.targetUri(), null, browserHeaders)
                : fetchBudgeted(session, session.targetUri(), null, browserHeaders);
        if (!headRequest) {
            sessionService.recordDocumentUri(session, fetched.finalUri());
        }
        return headRequest
                ? renderHeadResponse(fetched, session, cors)
                : renderFetched(fetched, session, cors);
    }

    @GetMapping("/api/live-reports/{sessionId}/resource")
    public ResponseEntity<byte[]> getResource(
            @PathVariable UUID sessionId,
            @RequestParam String nonce,
            @RequestParam String url,
            HttpServletRequest browserRequest
    ) {
        LiveReportSessionService.LiveReportSession session = sessionService.requireAuthorized(sessionId, nonce);
        browserRequest.setAttribute(CURRENT_SESSION_ATTRIBUTE, session);
        URI resourceUri;
        try {
            resourceUri = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, "Live report resource URL is malformed", e);
        }
        URI upstreamReferrer = resolveUpstreamReferrer(session, browserRequest);
        boolean headRequest = "HEAD".equalsIgnoreCase(browserRequest.getMethod());
        CorsRequestContext cors = resolveCorsRequest(session, browserRequest);
        LiveReportRequestHeaders browserHeaders = requestHeaders(browserRequest, cors);
        LiveReportFetchService.FetchedResource fetched = headRequest
                ? fetchHeadBudgeted(session, resourceUri, upstreamReferrer, browserHeaders)
                : fetchBudgeted(session, resourceUri, upstreamReferrer, browserHeaders);
        return headRequest
                ? renderHeadResponse(fetched, session, cors)
                : renderFetched(fetched, session, cors);
    }

    /**
     * Path-preserving live mirror. The catch-all is used only for routing; raw path and query are
     * extracted from the servlet request so percent-encoded upstream URL octets are not decoded and
     * re-encoded by Spring path binding.
     */
    @RequestMapping(
            path = "/api/live-reports/{sessionId}/mirror/{nonce}/{hostToken}/**",
            method = {RequestMethod.GET, RequestMethod.HEAD, RequestMethod.POST, RequestMethod.OPTIONS}
    )
    public ResponseEntity<byte[]> getMirror(
            @PathVariable UUID sessionId,
            @PathVariable String nonce,
            @PathVariable String hostToken,
            HttpServletRequest browserRequest
    ) {
        LiveReportSessionService.LiveReportSession session = sessionService.requireAuthorized(sessionId, nonce);
        browserRequest.setAttribute(CURRENT_SESSION_ATTRIBUTE, session);
        LiveReportMirrorUrl.DecodedMirrorRequest mirrorRequest = LiveReportMirrorUrl.decodeRequestPath(
                sessionId,
                nonce,
                browserRequest.getContextPath(),
                browserRequest.getRequestURI(),
                browserRequest.getQueryString()
        );
        if (!MessageDigest.isEqual(
                hostToken.getBytes(StandardCharsets.US_ASCII),
                mirrorRequest.hostToken().getBytes(StandardCharsets.US_ASCII)
        )) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, "Live report mirror host is invalid");
        }

        var existingDocumentUri = sessionService.documentUri(session);
        URI upstreamReferrer = existingDocumentUri.isEmpty()
                && mirrorRequest.targetUri().equals(session.targetUri())
                ? null
                : resolveUpstreamReferrer(session, browserRequest);
        boolean postRequest = "POST".equalsIgnoreCase(browserRequest.getMethod());
        boolean headRequest = "HEAD".equalsIgnoreCase(browserRequest.getMethod());
        boolean preflightRequest = "OPTIONS".equalsIgnoreCase(browserRequest.getMethod());
        boolean programmaticRequest = LiveReportTransport.isProgrammatic(browserRequest);
        if (postRequest && !programmaticRequest) {
            throw new LiveReportException(
                    HttpStatus.FORBIDDEN,
                    "Live report POST requests require fetch or XMLHttpRequest"
            );
        }
        CorsRequestContext cors = resolveCorsRequest(session, browserRequest);
        if (preflightRequest) {
            return handlePreflight(session, mirrorRequest.targetUri(), cors, browserRequest);
        }
        LiveReportRequestHeaders browserHeaders = requestHeaders(browserRequest, cors);
        LiveReportFetchService.FetchedResource fetched = postRequest
                ? fetchPostBudgeted(
                        session,
                        mirrorRequest.targetUri(),
                        upstreamReferrer,
                        browserHeaders,
                        browserRequest
                )
                : headRequest
                ? fetchHeadBudgeted(
                        session,
                        mirrorRequest.targetUri(),
                        upstreamReferrer,
                        browserHeaders
                )
                : fetchBudgeted(
                        session,
                        mirrorRequest.targetUri(),
                        upstreamReferrer,
                        browserHeaders
                );
        String requestedMirrorUrl = LiveReportMirrorUrl.toRelativeUrl(
                session.id(),
                session.nonce(),
                mirrorRequest.targetUri()
        );
        String finalMirrorUrl = LiveReportMirrorUrl.toRelativeUrl(
                session.id(),
                session.nonce(),
                fetched.finalUri()
        );
        if (!programmaticRequest && !requestedMirrorUrl.equals(finalMirrorUrl)) {
            return mirrorRedirect(finalMirrorUrl, fetched, cors);
        }
        ResponseEntity<byte[]> response = headRequest
                ? renderHeadResponse(fetched, session, cors)
                : programmaticRequest
                ? renderDynamicResponse(fetched, cors)
                : renderFetched(fetched, session, cors);
        if (!programmaticRequest
                && "GET".equalsIgnoreCase(browserRequest.getMethod())
                && fetched.isHtml()
                && existingDocumentUri.isEmpty()) {
            sessionService.recordDocumentUri(session, fetched.finalUri());
        }
        return response;
    }

    @ExceptionHandler(LiveReportException.class)
    public ResponseEntity<?> handleLiveReportException(
            LiveReportException exception,
            HttpServletRequest request
    ) {
        String errorCode = liveReportErrorCode(exception);
        if (isViewerNavigation(request)) {
            byte[] body = "HEAD".equalsIgnoreCase(request.getMethod())
                    ? new byte[0]
                    : viewerErrorDocument(exception, request).getBytes(StandardCharsets.UTF_8);
            return ResponseEntity.status(exception.getStatus())
                    .contentType(new MediaType("text", "html", StandardCharsets.UTF_8))
                    .contentLength(body.length)
                    .cacheControl(CacheControl.noStore())
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Referrer-Policy", "no-referrer")
                    .header(ERROR_HEADER, errorCode)
                    .header("Content-Security-Policy", viewerErrorCsp())
                    .body(body);
        }

        // Live gateway fetch/XHR callers and control-plane APIs retain the JSON
        // contract even when a browser advertises text/html. Setting the media
        // type explicitly also prevents Spring from trying to encode ApiResponse
        // with a text/html converter after an exception interrupts a replay.
        return ResponseEntity.status(exception.getStatus())
                .contentType(MediaType.APPLICATION_JSON)
                .cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .header(ERROR_HEADER, errorCode)
                .body(ApiResponse.fail(exception.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public void handleUnexpectedLiveReportException(
            Exception exception,
            HttpServletRequest request,
            HttpServletResponse response
    ) {
        boolean viewerNavigation = isViewerNavigation(request);
        log.warn(
                "Unexpected live report {} failure",
                viewerNavigation ? "viewer navigation" : "gateway request",
                exception
        );

        // A client may cancel an iframe while Spring is writing its successful
        // HTML response. In that case the response is already committed and any
        // second body write would only hide the original exception behind another
        // message-converter failure.
        if (response.isCommitted()) {
            return;
        }

        response.reset();
        response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader(ERROR_HEADER, "request-failed");

        byte[] body;
        if (viewerNavigation) {
            response.setContentType(MediaType.TEXT_HTML_VALUE);
            response.setHeader("Content-Security-Policy", viewerErrorCsp());
            body = "HEAD".equalsIgnoreCase(request.getMethod())
                    ? new byte[0]
                    : viewerErrorDocument(
                            new LiveReportException(
                                    HttpStatus.INTERNAL_SERVER_ERROR,
                                    "Live report request failed"
                            ),
                            request
                    ).getBytes(StandardCharsets.UTF_8);
        } else {
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            body = "HEAD".equalsIgnoreCase(request.getMethod())
                    ? new byte[0]
                    : "{\"success\":false,\"data\":null,\"message\":\"Live report request failed\"}"
                            .getBytes(StandardCharsets.UTF_8);
        }
        response.setContentLength(body.length);
        if (body.length == 0) {
            return;
        }
        try {
            response.getOutputStream().write(body);
        } catch (IOException writeFailure) {
            // The browser can legitimately abort a stale iframe during session
            // replacement. Preserve the original stack trace above and avoid a
            // second exception-handler failure for the disconnected response.
            log.debug("Live report error response could not be written", writeFailure);
        }
    }

    private boolean isViewerNavigation(HttpServletRequest request) {
        if (LiveReportTransport.isProgrammatic(request)
                || !("GET".equalsIgnoreCase(request.getMethod())
                || "HEAD".equalsIgnoreCase(request.getMethod()))) {
            return false;
        }

        String destination = request.getHeader("Sec-Fetch-Dest");
        if ("document".equalsIgnoreCase(destination) || "iframe".equalsIgnoreCase(destination)) {
            return true;
        }
        if (!acceptsHtml(request)) {
            return false;
        }

        if (request.getAttribute(LiveReportViewerRoutingFilter.ROUTE_TOKEN_ATTRIBUTE) instanceof String) {
            return true;
        }
        String path = request.getRequestURI();
        String liveReportPrefix = request.getContextPath() + "/api/live-reports/";
        return path.startsWith(liveReportPrefix)
                && (path.endsWith("/document") || path.contains("/mirror/"));
    }

    private boolean acceptsHtml(HttpServletRequest request) {
        String accept = request.getHeader(HttpHeaders.ACCEPT);
        if (accept == null || accept.length() > 2048) {
            return false;
        }
        String normalized = accept.toLowerCase(Locale.ROOT);
        return normalized.contains("text/html") || normalized.contains("application/xhtml+xml");
    }

    private String liveReportErrorCode(LiveReportException exception) {
        if ("Live report session budget was exceeded".equals(exception.getMessage())) {
            return SESSION_BUDGET_EXCEEDED;
        }
        if (exception.getStatus() == HttpStatus.GONE) {
            return "session-expired";
        }
        if (exception.getStatus() == HttpStatus.TOO_MANY_REQUESTS) {
            return "capacity-exceeded";
        }
        return "request-failed";
    }

    private String viewerErrorCsp() {
        return "sandbox allow-scripts allow-same-origin; default-src 'none'; "
                + "script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors "
                + originRoutes.dashboardFrameAncestorSources();
    }

    private String viewerErrorDocument(
            LiveReportException exception,
            HttpServletRequest request
    ) {
        boolean sessionEnded = exception.getStatus() == HttpStatus.GONE
                || SESSION_BUDGET_EXCEEDED.equals(liveReportErrorCode(exception));
        String title = sessionEnded ? "재현 페이지 연결이 만료되었습니다" : "재현 페이지를 불러오지 못했습니다";
        String detail = sessionEnded
                ? "대시보드에서 동적 화면을 다시 연결해 주세요."
                : "잠시 후 대시보드에서 다시 시도해 주세요.";
        String failureSignal = viewerFailureSignal(exception, request);
        return """
                <!doctype html>
                <html lang="ko">
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width,initial-scale=1">
                  <title>재현 페이지 연결 오류</title>
                  <style>
                    html,body{height:100%%;margin:0}body{display:grid;place-items:center;background:#f8fafc;color:#101828;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
                    main{max-width:420px;margin:24px;padding:24px;border:1px solid #e4e7ec;border-radius:16px;background:#fff;text-align:center;box-shadow:0 8px 24px rgba(16,24,40,.08)}
                    h1{margin:0 0 8px;font-size:18px;line-height:1.45}p{margin:0;color:#667085;font-size:14px;line-height:1.6}
                  </style>
                </head>
                <body><main><h1>%s</h1><p>%s</p></main>%s</body>
                </html>
                """.formatted(title, detail, failureSignal);
    }

    private String viewerFailureSignal(
            LiveReportException exception,
            HttpServletRequest request
    ) {
        Object current = request.getAttribute(CURRENT_SESSION_ATTRIBUTE);
        if (!(current instanceof LiveReportSessionService.LiveReportSession session)) {
            return "";
        }
        String errorCode = liveReportErrorCode(exception);
        String reason;
        if (SESSION_BUDGET_EXCEEDED.equals(errorCode)) {
            reason = "budget-exceeded";
        } else if ("session-expired".equals(errorCode)) {
            reason = "expired";
        } else {
            return "";
        }
        // session id and bridge secret are generated server-side URL-safe values.
        // The dashboard must additionally verify event.source and the exact viewer
        // origin before accepting this authenticated terminal-session signal.
        return "<script>parent.postMessage({source:'accessibility-page-live-report',"
                + "type:'SESSION_EXHAUSTED',protocolVersion:1,sessionId:'"
                + session.id() + "',bridgeSecret:'" + session.bridgeSecret()
                + "',reason:'" + reason + "'},'*')</script>";
    }

    private ResponseEntity<byte[]> renderFetched(
            LiveReportFetchService.FetchedResource resource,
            LiveReportSessionService.LiveReportSession session,
            CorsRequestContext cors
    ) {
        if (resource.isHtml()) {
            byte[] rewritten = chargeRewriteExpansion(
                    session,
                    resource,
                    documentRewriter.rewriteHtml(resource, session)
            );
            ResponseEntity.BodyBuilder response = baseResponse(
                    resource.statusCode(),
                    new MediaType("text", "html", StandardCharsets.UTF_8),
                    rewritten
            )
                    .header("Content-Security-Policy", documentCsp(session))
                    .header(
                            "Permissions-Policy",
                            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), document-domain=()"
                    );
            return applyCors(response, resource, cors).body(rewritten);
        }
        if (resource.isCss()) {
            byte[] rewritten = chargeRewriteExpansion(
                    session,
                    resource,
                    documentRewriter.rewriteCss(resource, session)
            );
            ResponseEntity.BodyBuilder response = baseResponse(
                    resource.statusCode(),
                    new MediaType("text", "css", StandardCharsets.UTF_8),
                    rewritten
            );
            return applyCors(response, resource, cors).body(rewritten);
        }
        if (resource.isJavaScript()) {
            byte[] rewritten = chargeRewriteExpansion(
                    session,
                    resource,
                    documentRewriter.rewriteJavaScript(resource, session)
            );
            ResponseEntity.BodyBuilder response = baseResponse(
                    resource.statusCode(),
                    new MediaType("application", "javascript", StandardCharsets.UTF_8),
                    rewritten
            );
            return applyCors(response, resource, cors).body(rewritten);
        }

        byte[] bytes = resource.bytes();
        ResponseEntity.BodyBuilder response = baseResponse(
                resource.statusCode(),
                parseMediaType(resource.contentType()),
                bytes
        ).header("Content-Security-Policy", "sandbox; default-src 'none'");
        return applyCors(response, resource, cors).body(bytes);
    }

    private ResponseEntity<byte[]> renderDynamicResponse(
            LiveReportFetchService.FetchedResource resource,
            CorsRequestContext cors
    ) {
        // fetch/XHR callers must receive byte-for-byte API payloads. Treating an
        // HTML fragment or JavaScript-valued response as a navigation document
        // would inject the bridge and corrupt the application's response body.
        byte[] bytes = resource.bytes();
        ResponseEntity.BodyBuilder response = baseResponse(
                resource.statusCode(),
                parseMediaType(resource.contentType()),
                bytes
        ).header("Content-Security-Policy", "sandbox; default-src 'none'");
        return applyCors(response, resource, cors).body(bytes);
    }

    private ResponseEntity<byte[]> renderHeadResponse(
            LiveReportFetchService.FetchedResource resource,
            LiveReportSessionService.LiveReportSession session,
            CorsRequestContext cors
    ) {
        byte[] emptyBody = new byte[0];
        ResponseEntity.BodyBuilder response;
        if (resource.isHtml()) {
            response = baseResponse(
                    resource.statusCode(),
                    new MediaType("text", "html", StandardCharsets.UTF_8),
                    emptyBody
            )
                    .header("Content-Security-Policy", documentCsp(session))
                    .header(
                            "Permissions-Policy",
                            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), document-domain=()"
                    );
        } else if (resource.isCss()) {
            response = baseResponse(
                    resource.statusCode(),
                    new MediaType("text", "css", StandardCharsets.UTF_8),
                    emptyBody
            );
        } else if (resource.isJavaScript()) {
            response = baseResponse(
                    resource.statusCode(),
                    new MediaType("application", "javascript", StandardCharsets.UTF_8),
                    emptyBody
            );
        } else {
            response = baseResponse(
                    resource.statusCode(),
                    parseMediaType(resource.contentType()),
                    emptyBody
            ).header("Content-Security-Policy", "sandbox; default-src 'none'");
        }
        return applyCors(response, resource, cors).body(emptyBody);
    }

    private byte[] chargeRewriteExpansion(
            LiveReportSessionService.LiveReportSession session,
            LiveReportFetchService.FetchedResource rawResource,
            byte[] rewritten
    ) {
        long expansion = (long) rewritten.length - rawResource.bytes().length;
        if (expansion > 0) {
            // The raw upstream transfer was charged by fetchBudgeted. Only charge
            // positive amplification here, so shrinking a response never refunds
            // real network cost and expansion cannot escape the session budget.
            sessionService.recordResponseBytes(session, expansion);
        }
        return rewritten;
    }

    private ResponseEntity<byte[]> mirrorRedirect(
            String finalMirrorUrl,
            LiveReportFetchService.FetchedResource resource,
            CorsRequestContext cors
    ) {
        ResponseEntity.BodyBuilder response = ResponseEntity.status(HttpStatus.FOUND)
                .location(URI.create(finalMirrorUrl))
                .contentLength(0)
                .cacheControl(CacheControl.noStore())
                .header("Referrer-Policy", "same-origin")
                .header("X-Content-Type-Options", "nosniff")
                .header("Cross-Origin-Resource-Policy", "cross-origin");
        return applyCors(response, resource, cors).body(new byte[0]);
    }

    private ResponseEntity<byte[]> viewerRedirect(
            String finalViewerUrl,
            LiveReportFetchService.FetchedResource resource,
            CorsRequestContext cors
    ) {
        ResponseEntity.BodyBuilder response = ResponseEntity.status(HttpStatus.FOUND)
                .location(URI.create(finalViewerUrl))
                .contentLength(0)
                .cacheControl(CacheControl.noStore())
                .header("Referrer-Policy", "same-origin")
                .header("X-Content-Type-Options", "nosniff")
                .header("Cross-Origin-Resource-Policy", "cross-origin");
        return applyCors(response, resource, cors).body(new byte[0]);
    }

    private LiveReportFetchService.FetchedResource fetchBudgeted(
            LiveReportSessionService.LiveReportSession session,
            URI uri,
            URI referrer,
            LiveReportRequestHeaders browserHeaders
    ) {
        try (LiveReportSessionService.RequestLease ignored = sessionService.acquireRequest(session)) {
            LiveReportFetchService.FetchedResource resource = fetchService.fetch(
                    session,
                    uri,
                    referrer,
                    browserHeaders
            );
            sessionService.recordResponseBytes(session, resource.bytes().length);
            return resource;
        }
    }

    private LiveReportFetchService.FetchedResource fetchHeadBudgeted(
            LiveReportSessionService.LiveReportSession session,
            URI uri,
            URI referrer,
            LiveReportRequestHeaders browserHeaders
    ) {
        try (LiveReportSessionService.RequestLease ignored = sessionService.acquireRequest(session)) {
            return fetchService.fetchHead(session, uri, referrer, browserHeaders);
        }
    }

    private LiveReportFetchService.FetchedResource fetchPostBudgeted(
            LiveReportSessionService.LiveReportSession session,
            URI uri,
            URI referrer,
            LiveReportRequestHeaders browserHeaders,
            HttpServletRequest browserRequest
    ) {
        return fetchPostBudgeted(session, uri, referrer, browserHeaders, null, browserRequest);
    }

    private LiveReportFetchService.FetchedResource fetchPostBudgeted(
            LiveReportSessionService.LiveReportSession session,
            URI uri,
            URI referrer,
            LiveReportRequestHeaders browserHeaders,
            URI requestOrigin,
            HttpServletRequest browserRequest
    ) {
        try (LiveReportSessionService.RequestLease ignored = sessionService.acquireRequest(session)) {
            byte[] body = readBoundedRequestBody(browserRequest);
            LiveReportFetchService.FetchedResource resource = requestOrigin == null
                    ? fetchService.fetchPost(
                            session,
                            uri,
                            referrer,
                            browserHeaders,
                            browserRequest.getContentType(),
                            body
                    )
                    : fetchService.fetchPost(
                            session,
                            uri,
                            referrer,
                            browserHeaders,
                            requestOrigin,
                            browserRequest.getContentType(),
                            body
                    );
            sessionService.recordResponseBytes(session, resource.bytes().length);
            return resource;
        }
    }

    private byte[] readBoundedRequestBody(HttpServletRequest request) {
        int maximum = Math.max(0, properties.getMaxRequestBodyBytes());
        long declaredLength = request.getContentLengthLong();
        if (declaredLength > maximum) {
            throw requestTooLarge();
        }
        int readLimit = maximum == Integer.MAX_VALUE ? maximum : maximum + 1;
        try {
            byte[] body = request.getInputStream().readNBytes(readLimit);
            if (body.length > maximum) {
                throw requestTooLarge();
            }
            return body;
        } catch (IOException e) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, "Live report request body could not be read", e);
        }
    }

    private LiveReportException requestTooLarge() {
        return new LiveReportException(
                HttpStatus.CONTENT_TOO_LARGE,
                "Live report request exceeds the configured size limit"
        );
    }

    private ResponseEntity.BodyBuilder baseResponse(int statusCode, MediaType contentType, byte[] bytes) {
        return ResponseEntity.status(statusCode)
                .contentType(contentType)
                .contentLength(bytes.length)
                .cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .header("Referrer-Policy", "same-origin")
                .header("Cross-Origin-Resource-Policy", "cross-origin");
    }

    private ResponseEntity<byte[]> handlePreflight(
            LiveReportSessionService.LiveReportSession session,
            URI targetUri,
            CorsRequestContext cors,
            HttpServletRequest request
    ) {
        String requestedMethod = normalizePreflightMethod(
                request.getHeader(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD)
        );
        String requestedHeaders = normalizePreflightHeaders(
                request.getHeader(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS)
        );
        if (cors == null || !cors.browserCrossOrigin()) {
            return deniedPreflight();
        }

        boolean virtualCrossOrigin = !sameOrigin(cors.upstreamSourceOrigin(), targetUri);
        if (virtualCrossOrigin) {
            LiveReportFetchService.FetchedResource upstream = fetchPreflightBudgeted(
                    session,
                    targetUri,
                    requestHeaders(request, cors),
                    requestedMethod,
                    requestedHeaders
            );
            if (!upstream.cors().originSupplied() || !upstream.cors().allowed()) {
                return deniedPreflight();
            }
        }

        ResponseEntity.BodyBuilder response = ResponseEntity.status(HttpStatus.NO_CONTENT)
                .contentLength(0)
                .cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .header(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, cors.browserOrigin())
                .header(HttpHeaders.ACCESS_CONTROL_ALLOW_METHODS, requestedMethod)
                .header(HttpHeaders.ACCESS_CONTROL_MAX_AGE, "600")
                .header(
                        HttpHeaders.VARY,
                        HttpHeaders.ORIGIN,
                        HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD,
                        HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS
                );
        if (requestedHeaders != null) {
            response.header(HttpHeaders.ACCESS_CONTROL_ALLOW_HEADERS, requestedHeaders);
        }
        return response.body(new byte[0]);
    }

    private LiveReportFetchService.FetchedResource fetchPreflightBudgeted(
            LiveReportSessionService.LiveReportSession session,
            URI uri,
            LiveReportRequestHeaders browserHeaders,
            String requestedMethod,
            String requestedHeaders
    ) {
        try (LiveReportSessionService.RequestLease ignored = sessionService.acquireRequest(session)) {
            LiveReportFetchService.FetchedResource resource = fetchService.fetchPreflight(
                    session,
                    uri,
                    browserHeaders,
                    requestedMethod,
                    requestedHeaders
            );
            sessionService.recordResponseBytes(session, resource.bytes().length);
            return resource;
        }
    }

    private ResponseEntity<byte[]> deniedPreflight() {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .contentLength(0)
                .cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .body(new byte[0]);
    }

    private String normalizePreflightMethod(String rawMethod) {
        String method = rawMethod == null ? "" : rawMethod.trim().toUpperCase(java.util.Locale.ROOT);
        if (!method.equals("GET") && !method.equals("HEAD") && !method.equals("POST")) {
            throw new LiveReportException(HttpStatus.FORBIDDEN, "Live report preflight method is not allowed");
        }
        return method;
    }

    private String normalizePreflightHeaders(String rawHeaders) {
        if (rawHeaders == null || rawHeaders.isBlank()) {
            return null;
        }
        if (rawHeaders.length() > 2048 || containsControl(rawHeaders)) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, "Live report preflight headers are invalid");
        }
        var values = java.util.Arrays.stream(rawHeaders.split(","))
                .map(String::trim)
                .map(value -> value.toLowerCase(java.util.Locale.ROOT))
                .distinct()
                .toList();
        String transport = LiveReportTransport.HEADER_NAME.toLowerCase(java.util.Locale.ROOT);
        if (values.isEmpty() || values.stream().anyMatch(value -> value.isEmpty()
                || !value.matches("[!#$%&'*+.^_`|~0-9a-z-]+")
                || (!value.equals(transport) && !value.equals("content-type")))) {
            throw new LiveReportException(HttpStatus.FORBIDDEN, "Live report preflight header is not supported");
        }
        return String.join(", ", values);
    }

    private ResponseEntity.BodyBuilder applyCors(
            ResponseEntity.BodyBuilder response,
            LiveReportFetchService.FetchedResource resource,
            CorsRequestContext cors
    ) {
        if (cors != null
                && cors.browserCrossOrigin()
                && resource.cors().originSupplied()
                && resource.cors().allowed()) {
            response.header(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, cors.browserOrigin());
            response.header(HttpHeaders.VARY, HttpHeaders.ORIGIN);
        }
        return response;
    }

    private LiveReportRequestHeaders requestHeaders(
            HttpServletRequest request,
            CorsRequestContext cors
    ) {
        LiveReportRequestHeaders headers = LiveReportRequestHeaders.from(request);
        return cors == null
                ? headers
                : headers.withUpstreamOrigin(cors.upstreamSourceOrigin().toASCIIString());
    }

    private CorsRequestContext resolveCorsRequest(
            LiveReportSessionService.LiveReportSession session,
            HttpServletRequest request
    ) {
        String rawOrigin = LiveReportGatewayCorsFilter.browserOrigin(request);
        URI browserOrigin = parseBrowserOrigin(rawOrigin);
        if (browserOrigin == null) {
            return null;
        }

        URI upstreamSourceOrigin;
        URI configuredGateway = URI.create(originRoutes.gatewayOrigin());
        if (sameOrigin(browserOrigin, configuredGateway)) {
            upstreamSourceOrigin = upstreamOrigin(
                    sessionService.documentUri(session).orElse(session.targetUri())
            );
        } else {
            try {
                LiveReportOriginRouteRegistry.RoutedRequest routedOrigin =
                        originRoutes.requireViewerRequest(browserOrigin.getHost(), "/", null);
                if (!routedOrigin.session().id().equals(session.id())
                        || !sameOrigin(browserOrigin, routedOrigin.route().viewerOrigin())) {
                    return null;
                }
                upstreamSourceOrigin = routedOrigin.upstreamOrigin();
            } catch (LiveReportException exception) {
                return null;
            }
        }

        URI browserRequestOrigin = browserRequestOrigin(request);
        return new CorsRequestContext(
                browserOrigin.toASCIIString(),
                upstreamSourceOrigin,
                !sameOrigin(browserOrigin, browserRequestOrigin)
        );
    }

    private URI parseBrowserOrigin(String rawOrigin) {
        if (rawOrigin == null || rawOrigin.length() > 2048
                || rawOrigin.indexOf(',') >= 0 || containsControl(rawOrigin)) {
            return null;
        }
        try {
            URI candidate = URI.create(rawOrigin.trim());
            String path = candidate.getRawPath();
            if (!candidate.isAbsolute()
                    || candidate.getHost() == null
                    || candidate.getRawUserInfo() != null
                    || candidate.getRawQuery() != null
                    || candidate.getRawFragment() != null
                    || (path != null && !path.isEmpty())
                    || !("https".equalsIgnoreCase(candidate.getScheme())
                    || "http".equalsIgnoreCase(candidate.getScheme()))) {
                return null;
            }
            return normalizedOrigin(candidate.getScheme(), candidate.getHost(), candidate.getPort());
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    private URI browserRequestOrigin(HttpServletRequest request) {
        return normalizedOrigin(request.getScheme(), request.getServerName(), request.getServerPort());
    }

    private URI upstreamOrigin(URI uri) {
        return normalizedOrigin(uri.getScheme(), uri.getHost(), uri.getPort());
    }

    private URI normalizedOrigin(String scheme, String host, int port) {
        if (scheme == null || host == null) {
            throw new IllegalArgumentException("Origin is incomplete");
        }
        String lowerScheme = scheme.toLowerCase(java.util.Locale.ROOT);
        String lowerHost = host.toLowerCase(java.util.Locale.ROOT);
        int normalizedPort = ("https".equals(lowerScheme) && port == 443)
                || ("http".equals(lowerScheme) && port == 80)
                ? -1
                : port;
        String authority = lowerHost.indexOf(':') >= 0 ? "[" + lowerHost + "]" : lowerHost;
        return URI.create(lowerScheme + "://" + authority
                + (normalizedPort < 0 ? "" : ":" + normalizedPort));
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

    private int effectivePort(URI uri) {
        if (uri.getPort() >= 0) {
            return uri.getPort();
        }
        return "http".equalsIgnoreCase(uri.getScheme()) ? 80 : 443;
    }

    private URI resolveUpstreamReferrer(
            LiveReportSessionService.LiveReportSession session,
            HttpServletRequest browserRequest
    ) {
        URI documentUri = sessionService.documentUri(session).orElse(session.targetUri());
        String rawReferrer = browserRequest.getHeader("Referer");
        if (rawReferrer == null || rawReferrer.length() > 8192 || containsControl(rawReferrer)) {
            return documentUri;
        }

        try {
            URI proxyReferrer = URI.create(rawReferrer);
            String routePrefix = browserRequest.getContextPath() + "/api/live-reports/" + session.id();
            String path = proxyReferrer.getPath();
            // Development and production reverse proxies may legitimately rewrite
            // Host. Bind the referrer to the exact session route and its secret
            // nonce instead of trusting either the inbound or forwarded host.
            if (path == null) {
                return documentUri;
            }
            try {
                return LiveReportMirrorUrl.decodeRequestPath(
                        session.id(),
                        session.nonce(),
                        browserRequest.getContextPath(),
                        proxyReferrer.getRawPath(),
                        proxyReferrer.getRawQuery()
                ).targetUri();
            } catch (LiveReportException ignored) {
                // Compatibility routes below remain valid during the rollout.
            }
            var query = UriComponentsBuilder.fromUri(proxyReferrer).build().getQueryParams();
            String proxyNonce = decodeQueryValue(query.getFirst("nonce"));
            if (!constantTimeEquals(session.nonce(), proxyNonce)) {
                return documentUri;
            }
            if (path.equals(routePrefix + "/document")) {
                return documentUri;
            }
            if (path.equals(routePrefix + "/resource")) {
                String upstreamUrl = decodeQueryValue(query.getFirst("url"));
                if (upstreamUrl != null && upstreamUrl.length() <= 8192 && !containsControl(upstreamUrl)) {
                    URI candidate = URI.create(upstreamUrl);
                    if ("https".equalsIgnoreCase(candidate.getScheme()) && candidate.getHost() != null) {
                        return candidate;
                    }
                }
            }
        } catch (IllegalArgumentException ignored) {
            // Fall back to the final owning document for malformed or forged proxy referrers.
        }
        return documentUri;
    }

    private URI resolveViewerUpstreamReferrer(
            LiveReportOriginRouteRegistry.RoutedRequest routed,
            HttpServletRequest browserRequest
    ) {
        URI fallback = sessionService.documentUri(routed.session()).orElse(routed.targetUri());
        String rawReferrer = browserRequest.getHeader("Referer");
        if (rawReferrer == null || rawReferrer.length() > 8192 || containsControl(rawReferrer)) {
            return fallback;
        }
        try {
            URI referrer = URI.create(rawReferrer);
            LiveReportOriginRouteRegistry.RoutedRequest decoded = originRoutes.requireViewerRequest(
                    referrer.getHost(),
                    referrer.getRawPath(),
                    referrer.getRawQuery()
            );
            return decoded.session().id().equals(routed.session().id())
                    ? decoded.targetUri()
                    : fallback;
        } catch (IllegalArgumentException | LiveReportException ignored) {
            return fallback;
        }
    }

    private String decodeQueryValue(String value) {
        return value == null ? null : UriUtils.decode(value, StandardCharsets.UTF_8);
    }

    private boolean constantTimeEquals(String expected, String actual) {
        byte[] left = expected == null ? new byte[0] : expected.getBytes(StandardCharsets.UTF_8);
        byte[] right = actual == null ? new byte[0] : actual.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(left, right);
    }

    private boolean containsControl(String value) {
        return value.chars().anyMatch(character -> character < 0x20 || character == 0x7f);
    }

    private MediaType parseMediaType(String contentType) {
        try {
            return MediaType.parseMediaType(contentType);
        } catch (IllegalArgumentException ignored) {
            return MediaType.APPLICATION_OCTET_STREAM;
        }
    }

    private String documentCsp(LiveReportSessionService.LiveReportSession session) {
        String viewerSource = originRoutes.viewerWildcardSource();
        String gatewaySource = originRoutes.gatewayOrigin();
        return "sandbox allow-scripts allow-same-origin allow-forms; "
                + "default-src 'none'; "
                + "script-src 'self' " + viewerSource + " " + gatewaySource
                + " 'unsafe-inline' 'unsafe-eval'; "
                + "style-src 'self' " + viewerSource + " " + gatewaySource + " data: 'unsafe-inline'; "
                + "img-src 'self' " + viewerSource + " " + gatewaySource + " data: blob:; "
                + "font-src 'self' " + viewerSource + " " + gatewaySource + " data:; "
                + "media-src 'self' " + viewerSource + " " + gatewaySource + " data: blob:; "
                + "connect-src 'self' " + viewerSource + " " + gatewaySource + "; "
                + "frame-src 'self' " + viewerSource + " " + gatewaySource + "; "
                + "child-src 'self' " + viewerSource + " " + gatewaySource + "; worker-src 'none'; "
                + "object-src 'none'; base-uri 'self' " + viewerSource + "; "
                + "form-action 'self' " + viewerSource + " " + gatewaySource + "; "
                // Top-level replay documents are framed by the dashboard. Nested upstream frames
                // are framed by another viewer alias (or by the compatibility gateway), so those
                // origins must be valid ancestors as well.
                + "frame-ancestors " + originRoutes.dashboardFrameAncestorSources() + " "
                + viewerSource + " " + gatewaySource;
    }

    public record LiveReportSessionResponse(
            UUID sessionId,
            String runtimeUrl,
            String viewerOrigin,
            String nonce,
            String bridgeSecret,
            Instant expiresAt
    ) {
    }

    private record CorsRequestContext(
            String browserOrigin,
            URI upstreamSourceOrigin,
            boolean browserCrossOrigin
    ) {
    }
}
