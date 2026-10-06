package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.http.HttpStatus;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.matchesPattern;
import static org.hamcrest.Matchers.not;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class LiveReportControllerTest {
    private final LiveReportLaunchService launchService = mock(LiveReportLaunchService.class);
    private final LiveReportSessionService sessionService = mock(LiveReportSessionService.class);
    private final LiveReportFetchService fetchService = mock(LiveReportFetchService.class);
    private final LiveReportDocumentRewriter rewriter = mock(LiveReportDocumentRewriter.class);
    private final LiveReportProperties properties = new LiveReportProperties();
    private final LiveReportOriginRouteRegistry originRoutes = new LiveReportOriginRouteRegistry(
            sessionService,
            properties,
            Clock.fixed(Instant.parse("2026-09-01T12:00:00Z"), ZoneOffset.UTC)
    );
    private final UUID sessionId = UUID.fromString("6b2d884e-a7f4-4f09-9776-688d08fe8912");
    private final LiveReportSessionService.LiveReportSession session = new LiveReportSessionService.LiveReportSession(
            sessionId,
            7L,
            URI.create("https://example.com/final"),
            "test-nonce",
            "test-bridge-secret",
            Instant.parse("2026-09-01T12:05:00Z")
    );
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        when(sessionService.documentUri(session)).thenReturn(Optional.of(session.targetUri()));
        mockMvc = MockMvcBuilders.standaloneSetup(new LiveReportController(
                launchService,
                sessionService,
                fetchService,
                rewriter,
                properties,
                originRoutes
        )).addFilters(
                new LiveReportViewerRoutingFilter(originRoutes),
                new LiveReportTransportFilter(properties)
        ).build();
    }

    @Test
    void createsIsolatedViewerOriginSessionWithNonceProtectedRuntimeUrl() throws Exception {
        when(launchService.createForRequest(7L)).thenReturn(session);

        mockMvc.perform(post("/api/results/requests/7/live-session"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.sessionId").value(sessionId.toString()))
                .andExpect(jsonPath("$.data.viewerOrigin", matchesPattern(
                        "http://[a-f0-9]{40}\\.localhost:9090"
                )))
                .andExpect(jsonPath("$.data.nonce").value("test-nonce"))
                .andExpect(jsonPath("$.data.bridgeSecret").value("test-bridge-secret"))
                .andExpect(jsonPath("$.data.runtimeUrl", matchesPattern(
                        "http://[a-f0-9]{40}\\.localhost:9090/final"
                )))
                .andExpect(jsonPath("$.data.runtimeUrl", not(containsString("test-bridge-secret"))));
    }

    @Test
    void renewsTheSameSessionWithoutChangingItsRuntimeIdentity() throws Exception {
        LiveReportSessionService.LiveReportSession renewed = new LiveReportSessionService.LiveReportSession(
                session.id(),
                session.requestId(),
                session.targetUri(),
                session.nonce(),
                session.bridgeSecret(),
                Instant.parse("2026-09-01T12:10:00Z")
        );
        when(launchService.renewForRequest(7L, sessionId)).thenReturn(renewed);

        mockMvc.perform(post("/api/results/requests/7/live-session/{sessionId}/renew", sessionId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.sessionId").value(sessionId.toString()))
                .andExpect(jsonPath("$.data.nonce").value("test-nonce"))
                .andExpect(jsonPath("$.data.bridgeSecret").value("test-bridge-secret"))
                .andExpect(jsonPath("$.data.expiresAt").value("2026-09-01T12:10:00Z"));

        verify(launchService).renewForRequest(7L, sessionId);
    }

    @Test
    void routesAnUpstreamApiPathOnTheDedicatedViewerHostBeforeMvcHandlerSelection() throws Exception {
        URI endpoint = URI.create("https://example.com/api/items?page=1&return=/home");
        byte[] responseBody = "{\"items\":[]}".getBytes(StandardCharsets.UTF_8);
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(session, endpoint);
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                endpoint,
                "application/json",
                responseBody
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenReturn(mock(LiveReportSessionService.RequestLease.class));
        when(fetchService.fetch(
                eq(session),
                eq(endpoint),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class)
        )).thenReturn(fetched);

        mockMvc.perform(get("/api/items")
                        .queryParam("page", "1")
                        .queryParam("return", "/home")
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.FETCH)
                        .with(request -> {
                            request.setScheme("http");
                            request.setServerName(route.viewerOrigin().getHost());
                            request.setServerPort(9090);
                            return request;
                        }))
                .andExpect(status().isOk())
                .andExpect(content().contentType("application/json"))
                .andExpect(content().bytes(responseBody));

        verify(fetchService).fetch(
                eq(session),
                eq(endpoint),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class)
        );
    }

    @Test
    void rendersAContainedHtmlErrorWhenViewerNavigationExhaustsItsSessionBudget() throws Exception {
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(
                session,
                session.targetUri()
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenThrow(new LiveReportException(
                HttpStatus.TOO_MANY_REQUESTS,
                "Live report session budget was exceeded"
        ));

        mockMvc.perform(get("/final")
                        .header("Accept", "text/html,application/xhtml+xml")
                        .header("Sec-Fetch-Dest", "iframe")
                        .with(request -> {
                            request.setScheme("http");
                            request.setServerName(route.viewerOrigin().getHost());
                            request.setServerPort(9090);
                            return request;
                        }))
                .andExpect(status().isTooManyRequests())
                .andExpect(content().contentType("text/html;charset=UTF-8"))
                .andExpect(header().string(
                        LiveReportController.ERROR_HEADER,
                        LiveReportController.SESSION_BUDGET_EXCEEDED
                ))
                .andExpect(header().string("Cache-Control", containsString("no-store")))
                .andExpect(header().string("Content-Security-Policy", containsString("default-src 'none'")))
                .andExpect(content().string(containsString("재현 페이지 연결이 만료되었습니다")))
                .andExpect(content().string(containsString("type:'SESSION_EXHAUSTED'")))
                .andExpect(content().string(containsString("sessionId:'" + sessionId + "'")))
                .andExpect(content().string(containsString("bridgeSecret:'test-bridge-secret'")))
                .andExpect(content().string(containsString("reason:'budget-exceeded'")))
                .andExpect(content().string(not(containsString("{\"success\""))));
    }

    @Test
    void keepsProgrammaticViewerFailuresOnTheJsonGatewayContract() throws Exception {
        URI endpoint = URI.create("https://example.com/api/items");
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(session, endpoint);
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenThrow(new LiveReportException(
                HttpStatus.TOO_MANY_REQUESTS,
                "Live report session budget was exceeded"
        ));

        mockMvc.perform(get("/api/items")
                        .header("Accept", "text/html")
                        .header("Sec-Fetch-Dest", "empty")
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.FETCH)
                        .with(request -> {
                            request.setScheme("http");
                            request.setServerName(route.viewerOrigin().getHost());
                            request.setServerPort(9090);
                            return request;
                        }))
                .andExpect(status().isTooManyRequests())
                .andExpect(content().contentType("application/json"))
                .andExpect(header().string(
                        LiveReportController.ERROR_HEADER,
                        LiveReportController.SESSION_BUDGET_EXCEEDED
                ))
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.message").value("Live report session budget was exceeded"));
    }

    @Test
    void masksUnexpectedViewerFailuresBehindAContainedHtmlResponse() throws Exception {
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(
                session,
                session.targetUri()
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenReturn(
                mock(LiveReportSessionService.RequestLease.class)
        );
        when(fetchService.fetch(
                eq(session),
                eq(session.targetUri()),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class)
        )).thenThrow(new IllegalStateException("sensitive upstream implementation detail"));

        mockMvc.perform(get("/final")
                        .header("Accept", "text/html,application/xhtml+xml")
                        .header("Sec-Fetch-Dest", "iframe")
                        .with(request -> {
                            request.setScheme("http");
                            request.setServerName(route.viewerOrigin().getHost());
                            request.setServerPort(9090);
                            return request;
                        }))
                .andExpect(status().isInternalServerError())
                .andExpect(content().contentType("text/html;charset=UTF-8"))
                .andExpect(header().string(LiveReportController.ERROR_HEADER, "request-failed"))
                .andExpect(header().string("Content-Security-Policy", containsString("default-src 'none'")))
                .andExpect(content().string(containsString("재현 페이지를 불러오지 못했습니다")))
                .andExpect(content().string(not(containsString("sensitive upstream implementation detail"))))
                .andExpect(content().string(not(containsString("{\"success\""))));
    }

    @Test
    void masksUnexpectedProgrammaticFailuresBehindExplicitJson() throws Exception {
        URI endpoint = URI.create("https://example.com/api/items");
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(session, endpoint);
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenReturn(
                mock(LiveReportSessionService.RequestLease.class)
        );
        when(fetchService.fetch(
                eq(session),
                eq(endpoint),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class)
        )).thenThrow(new IllegalStateException("database password must stay private"));

        mockMvc.perform(get("/api/items")
                        .header("Accept", "text/html")
                        .header("Sec-Fetch-Dest", "empty")
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.FETCH)
                        .with(request -> {
                            request.setScheme("http");
                            request.setServerName(route.viewerOrigin().getHost());
                            request.setServerPort(9090);
                            return request;
                        }))
                .andExpect(status().isInternalServerError())
                .andExpect(content().contentType("application/json;charset=UTF-8"))
                .andExpect(header().string(LiveReportController.ERROR_HEADER, "request-failed"))
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.message").value("Live report request failed"))
                .andExpect(content().string(not(containsString("database password"))));
    }

    @Test
    void bindsViewerHostProgrammaticPostsToThatRoutesUpstreamOrigin() throws Exception {
        URI endpoint = URI.create("https://example.com/api/content");
        URI upstreamOrigin = URI.create("https://example.com");
        byte[] requestBody = "{\"page\":1}".getBytes(StandardCharsets.UTF_8);
        byte[] responseBody = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(session, endpoint);
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                endpoint,
                "application/json",
                responseBody
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenReturn(mock(LiveReportSessionService.RequestLease.class));
        when(fetchService.fetchPost(
                eq(session),
                eq(endpoint),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class),
                eq(upstreamOrigin),
                eq("application/json"),
                eq(requestBody)
        )).thenReturn(fetched);

        mockMvc.perform(post("/api/content")
                        .contentType("application/json")
                        .content(requestBody)
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.XHR)
                        .with(request -> {
                            request.setScheme("http");
                            request.setServerName(route.viewerOrigin().getHost());
                            request.setServerPort(9090);
                            return request;
                        }))
                .andExpect(status().isOk())
                .andExpect(content().contentType("application/json"))
                .andExpect(content().bytes(responseBody));

        verify(fetchService).fetchPost(
                eq(session),
                eq(endpoint),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class),
                eq(upstreamOrigin),
                eq("application/json"),
                eq(requestBody)
        );
    }

    @Test
    void doesNotExposePlatformApiHandlersThroughAnUnknownViewerRouteHost() throws Exception {
        String unknownRouteHost = "0".repeat(40) + ".localhost";

        mockMvc.perform(get("/api/live-reports/{id}/document", sessionId)
                        .queryParam("nonce", "test-nonce")
                        .with(request -> {
                            request.setScheme("http");
                            request.setServerName(unknownRouteHost);
                            request.setServerPort(9090);
                            return request;
                        }))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.message").value("Live report viewer route was not found"));

        verify(sessionService, never()).requireAuthorized(any(), any());
        verify(fetchService, never()).fetch(any(), any(), any(), any());
    }

    @Test
    void rejectsAnInvalidRawViewerQueryBeforeFetchingUpstream() throws Exception {
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(
                session,
                URI.create("https://example.com/api/items")
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);

        mockMvc.perform(get("/api/items")
                        .with(request -> {
                            request.setScheme("http");
                            request.setServerName(route.viewerOrigin().getHost());
                            request.setServerPort(9090);
                            request.setQueryString("page=1#forged-fragment");
                            return request;
                        }))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("Live report viewer location is invalid"));

        verify(fetchService, never()).fetch(any(), any(), any(), any());
    }

    @Test
    void servesDocumentWithFormsRestrictedToTheReplayViewerAndGateway() throws Exception {
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                session.targetUri(),
                "text/html",
                "source".getBytes(StandardCharsets.UTF_8)
        );
        byte[] rewritten = "<html>rewritten</html>".getBytes(StandardCharsets.UTF_8);
        stubBudgetedFetch(session.targetUri(), fetched);
        when(rewriter.rewriteHtml(fetched, session)).thenReturn(rewritten);

        mockMvc.perform(get("/api/live-reports/{id}/document", sessionId).param("nonce", "test-nonce"))
                .andExpect(status().isOk())
                .andExpect(content().bytes(rewritten))
                .andExpect(content().contentType("text/html;charset=UTF-8"))
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString("sandbox allow-scripts allow-same-origin allow-forms")
                ))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString("script-src 'self' http://*.localhost:9090 http://localhost:9090")
                ))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString("connect-src 'self' http://*.localhost:9090 http://localhost:9090")
                ))
                .andExpect(header().string("Content-Security-Policy", not(containsString("connect-src https:"))))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString("form-action 'self' http://*.localhost:9090 http://localhost:9090")
                ))
                .andExpect(header().string("Content-Security-Policy", not(containsString("form-action https:"))))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString("base-uri 'self' http://*.localhost:9090")
                ))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString(
                                "frame-ancestors http://localhost:5173 http://127.0.0.1:5173 "
                                        + "http://*.localhost:9090 http://localhost:9090"
                        )
                ));
    }

    @Test
    void servesPathPreservingMirrorWithRawQueryAndDecodedMirrorReferrer() throws Exception {
        URI scriptUri = URI.create("https://cdn.example.com/assets/app.js?v=1&lang=ko");
        URI stylesheetUri = URI.create("https://cdn.example.com/styles/site.css?theme=dark");
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                scriptUri,
                "application/javascript",
                "import('./chunk.js')".getBytes(StandardCharsets.UTF_8)
        );
        byte[] rewritten = "import('./mirrored-chunk.js')".getBytes(StandardCharsets.UTF_8);
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenReturn(mock(LiveReportSessionService.RequestLease.class));
        when(fetchService.fetch(
                eq(session),
                eq(scriptUri),
                eq(stylesheetUri),
                any(LiveReportRequestHeaders.class)
        )).thenReturn(fetched);
        when(rewriter.rewriteJavaScript(fetched, session)).thenReturn(rewritten);

        String mirrorPrefix = "/api/live-reports/" + sessionId + "/mirror/test-nonce/Y2RuLmV4YW1wbGUuY29t";
        mockMvc.perform(get(mirrorPrefix + "/assets/app.js")
                        .queryParam("v", "1")
                        .queryParam("lang", "ko")
                        .header("Referer", "http://localhost" + mirrorPrefix
                                + "/styles/site.css?theme=dark"))
                .andExpect(status().isOk())
                .andExpect(content().bytes(rewritten))
                .andExpect(content().contentType("application/javascript;charset=UTF-8"));

        verify(fetchService).fetch(
                eq(session),
                eq(scriptUri),
                eq(stylesheetUri),
                any(LiveReportRequestHeaders.class)
        );
    }

    @Test
    void forwardsSmallSameOriginJsonPostThroughTheMirrorAndChargesBothDirections() throws Exception {
        URI endpoint = URI.create("https://example.com/api/content");
        byte[] requestBody = "{\"page\":1}".getBytes(StandardCharsets.UTF_8);
        byte[] responseBody = "{\"items\":[]}".getBytes(StandardCharsets.UTF_8);
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                endpoint,
                "application/json",
                responseBody
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenReturn(mock(LiveReportSessionService.RequestLease.class));
        when(fetchService.fetchPost(
                eq(session),
                eq(endpoint),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class),
                eq("application/json"),
                eq(requestBody)
        )).thenReturn(fetched);

        String mirror = LiveReportMirrorUrl.toRelativeUrl(sessionId, session.nonce(), endpoint);
        mockMvc.perform(post(mirror)
                        .contentType("application/json")
                        .content(requestBody)
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.FETCH)
                        .header("Authorization", "Bearer browser-secret"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("application/json"))
                .andExpect(content().bytes(responseBody));

        verify(fetchService).fetchPost(
                eq(session),
                eq(endpoint),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class),
                eq("application/json"),
                eq(requestBody)
        );
        verify(sessionService).recordResponseBytes(session, (long) responseBody.length);
    }

    @Test
    void rejectsUnmarkedAndMultipartPostsBeforeControllerOrBodyProcessing() throws Exception {
        URI endpoint = URI.create("https://example.com/api/content");
        String mirror = LiveReportMirrorUrl.toRelativeUrl(sessionId, session.nonce(), endpoint);

        mockMvc.perform(post(mirror)
                        .contentType("application/x-www-form-urlencoded")
                        .content("page=1"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.message").value(
                        "Live report POST requests require fetch or XMLHttpRequest"
                ));
        mockMvc.perform(post(mirror)
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.XHR)
                        .contentType("multipart/form-data; boundary=test")
                        .content("--test--"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.message").value("Live report multipart requests are not allowed"));
        properties.setMaxRequestBodyBytes(4);
        mockMvc.perform(post(mirror)
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.FETCH)
                        .contentType("application/octet-stream")
                        .content(new byte[5]))
                .andExpect(status().is(413))
                .andExpect(jsonPath("$.message").value(
                        "Live report request exceeds the configured size limit"
                ));

        verify(sessionService, never()).requireAuthorized(any(), any());
        verify(fetchService, never()).fetchPost(any(), any(), any(), any(), any(), any());
    }

    @Test
    void preservesProgrammaticHtmlResponseBytesWithoutInvokingTheDocumentRewriter() throws Exception {
        URI endpoint = URI.create("https://example.com/api/fragment");
        URI postEndpoint = URI.create("https://example.com/api/fragment-post");
        byte[] responseBody = "<section data-fragment>raw</section>".getBytes(StandardCharsets.UTF_8);
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                endpoint,
                "text/html;charset=UTF-8",
                responseBody
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenReturn(mock(LiveReportSessionService.RequestLease.class));
        when(fetchService.fetch(eq(session), eq(endpoint), eq(session.targetUri()), any()))
                .thenReturn(fetched);
        when(fetchService.fetchPost(
                eq(session),
                eq(postEndpoint),
                eq(session.targetUri()),
                any(),
                eq("text/plain"),
                eq("query".getBytes(StandardCharsets.UTF_8))
        )).thenReturn(new LiveReportFetchService.FetchedResource(
                postEndpoint,
                "text/html;charset=UTF-8",
                responseBody
        ));

        mockMvc.perform(get(LiveReportMirrorUrl.toRelativeUrl(sessionId, session.nonce(), endpoint))
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.FETCH))
                .andExpect(status().isOk())
                .andExpect(content().bytes(responseBody))
                .andExpect(content().contentType("text/html;charset=UTF-8"));
        mockMvc.perform(post(LiveReportMirrorUrl.toRelativeUrl(sessionId, session.nonce(), postEndpoint))
                        .header(LiveReportTransport.HEADER_NAME, LiveReportTransport.XHR)
                        .contentType("text/plain")
                        .content("query"))
                .andExpect(status().isOk())
                .andExpect(content().bytes(responseBody))
                .andExpect(content().contentType("text/html;charset=UTF-8"));

        verify(rewriter, never()).rewriteHtml(any(), any());
    }

    @Test
    void servesCompatibilityMirrorDocumentWithOnlyConfiguredReplayOriginsAllowedByCsp() throws Exception {
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                session.targetUri(),
                "text/html",
                "source".getBytes(StandardCharsets.UTF_8)
        );
        byte[] rewritten = "<html>rewritten</html>".getBytes(StandardCharsets.UTF_8);
        when(sessionService.documentUri(session)).thenReturn(Optional.empty());
        stubBudgetedFetch(session.targetUri(), fetched);
        when(rewriter.rewriteHtml(fetched, session)).thenReturn(rewritten);

        String sessionMirrorPrefix = "/api/live-reports/" + sessionId + "/mirror/test-nonce/";
        mockMvc.perform(get(sessionMirrorPrefix + "ZXhhbXBsZS5jb20/final"))
                .andExpect(status().isOk())
                .andExpect(content().bytes(rewritten))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        not(containsString(sessionMirrorPrefix))
                ))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString("connect-src 'self' http://*.localhost:9090 http://localhost:9090")
                ))
                .andExpect(header().string("Content-Security-Policy", not(containsString("/resource?"))))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString("sandbox allow-scripts allow-same-origin allow-forms")
                ))
                .andExpect(header().string(
                        "Content-Security-Policy",
                        containsString("form-action 'self' http://*.localhost:9090 http://localhost:9090")
                ));

        verify(sessionService).recordDocumentUri(session, fetched.finalUri());
    }

    @Test
    void redirectsMirrorToTheCanonicalFinalUpstreamPathBeforeRendering() throws Exception {
        URI finalDocument = URI.create("https://www.example.com/app/index.html?lang=ko");
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                finalDocument,
                "text/html",
                "upstream body".getBytes(StandardCharsets.UTF_8)
        );
        when(sessionService.documentUri(session)).thenReturn(Optional.empty());
        stubBudgetedFetch(session.targetUri(), fetched);

        String requestedMirror = LiveReportMirrorUrl.toRelativeUrl(
                sessionId, session.nonce(), session.targetUri()
        );
        String finalMirror = LiveReportMirrorUrl.toRelativeUrl(
                sessionId, session.nonce(), finalDocument
        );
        mockMvc.perform(get(requestedMirror))
                .andExpect(status().isFound())
                .andExpect(header().string("Location", finalMirror))
                .andExpect(header().string("Cache-Control", containsString("no-store")))
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"))
                .andExpect(header().string("Cross-Origin-Resource-Policy", "cross-origin"))
                .andExpect(content().bytes(new byte[0]));

        verify(sessionService).recordResponseBytes(session, (long) fetched.bytes().length);
        verify(sessionService, never()).recordDocumentUri(session, finalDocument);
        verify(rewriter, never()).rewriteHtml(any(), eq(session));
    }

    @Test
    void servesAndRecordsTheFinalDocumentAfterTheBrowserFollowsMirrorRedirect() throws Exception {
        URI finalDocument = URI.create("https://www.example.com/app/index.html?lang=ko");
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                finalDocument,
                "text/html",
                "upstream body".getBytes(StandardCharsets.UTF_8)
        );
        byte[] rewritten = "<html>final</html>".getBytes(StandardCharsets.UTF_8);
        when(sessionService.documentUri(session)).thenReturn(Optional.empty());
        stubBudgetedFetch(finalDocument, fetched);
        when(rewriter.rewriteHtml(fetched, session)).thenReturn(rewritten);

        String initialMirror = LiveReportMirrorUrl.toRelativeUrl(
                sessionId, session.nonce(), session.targetUri()
        );
        String finalMirror = LiveReportMirrorUrl.toRelativeUrl(
                sessionId, session.nonce(), finalDocument
        );
        mockMvc.perform(get(finalMirror).header("Referer", "http://localhost" + initialMirror))
                .andExpect(status().isOk())
                .andExpect(header().doesNotExist("Location"))
                .andExpect(content().bytes(rewritten));

        verify(fetchService).fetch(
                eq(session),
                eq(finalDocument),
                eq(session.targetUri()),
                any(LiveReportRequestHeaders.class)
        );
        verify(sessionService).recordDocumentUri(session, finalDocument);
    }

    @Test
    void explicitDefaultHttpsPortCanonicalizesWithoutCreatingRedirectLoop() throws Exception {
        URI finalDocument = URI.create("https://example.com:443/final");
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                finalDocument,
                "text/html",
                "upstream body".getBytes(StandardCharsets.UTF_8)
        );
        byte[] rewritten = "<html>final</html>".getBytes(StandardCharsets.UTF_8);
        when(sessionService.documentUri(session)).thenReturn(Optional.empty());
        stubBudgetedFetch(session.targetUri(), fetched);
        when(rewriter.rewriteHtml(fetched, session)).thenReturn(rewritten);

        mockMvc.perform(get(LiveReportMirrorUrl.toRelativeUrl(
                        sessionId, session.nonce(), session.targetUri()
                )))
                .andExpect(status().isOk())
                .andExpect(header().doesNotExist("Location"))
                .andExpect(content().bytes(rewritten));

        verify(sessionService).recordDocumentUri(session, finalDocument);
    }

    @Test
    void sandboxesScriptableNonHtmlResourcesWhenOpenedAsDocuments() throws Exception {
        URI svgUri = URI.create("https://cdn.example.com/icon.svg");
        byte[] svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"
                .getBytes(StandardCharsets.UTF_8);
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                svgUri,
                "image/svg+xml",
                svg
        );
        stubBudgetedFetch(svgUri, fetched);

        mockMvc.perform(get("/api/live-reports/{id}/resource", sessionId)
                        .param("nonce", "test-nonce")
                        .param("url", svgUri.toString()))
                .andExpect(status().isOk())
                .andExpect(content().bytes(svg))
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"))
                .andExpect(header().string("Content-Security-Policy", "sandbox; default-src 'none'"));
    }

    @Test
    void rewritesJavaScriptModulesBeforeServingThemWithAStableMimeType() throws Exception {
        URI scriptUri = URI.create("https://cdn.example.com/assets/app.mjs");
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                scriptUri,
                "text/javascript;charset=UTF-8",
                "import('./chunk.js')".getBytes(StandardCharsets.UTF_8)
        );
        byte[] rewritten = "import('/api/live-reports/chunk')".getBytes(StandardCharsets.UTF_8);
        stubBudgetedFetch(scriptUri, fetched);
        when(rewriter.rewriteJavaScript(fetched, session)).thenReturn(rewritten);

        mockMvc.perform(get("/api/live-reports/{id}/resource", sessionId)
                        .param("nonce", "test-nonce")
                        .param("url", scriptUri.toString()))
                .andExpect(status().isOk())
                .andExpect(content().bytes(rewritten))
                .andExpect(content().contentType("application/javascript;charset=UTF-8"));

        verify(rewriter).rewriteJavaScript(fetched, session);
    }

    @Test
    void chargesRawBytesPlusOnlyPositiveHtmlCssAndJavaScriptRewriteExpansion() throws Exception {
        URI cssUri = URI.create("https://cdn.example.com/app.css");
        URI scriptUri = URI.create("https://cdn.example.com/app.js");
        LiveReportFetchService.FetchedResource html = new LiveReportFetchService.FetchedResource(
                session.targetUri(), "text/html", new byte[3]
        );
        LiveReportFetchService.FetchedResource css = new LiveReportFetchService.FetchedResource(
                cssUri, "text/css", new byte[4]
        );
        LiveReportFetchService.FetchedResource javascript = new LiveReportFetchService.FetchedResource(
                scriptUri, "application/javascript", new byte[5]
        );
        stubBudgetedFetch(session.targetUri(), html);
        stubBudgetedFetch(cssUri, css);
        stubBudgetedFetch(scriptUri, javascript);
        when(rewriter.rewriteHtml(html, session)).thenReturn(new byte[9]);
        when(rewriter.rewriteCss(css, session)).thenReturn(new byte[11]);
        when(rewriter.rewriteJavaScript(javascript, session)).thenReturn(new byte[13]);

        mockMvc.perform(get("/api/live-reports/{id}/document", sessionId).param("nonce", "test-nonce"))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/live-reports/{id}/resource", sessionId)
                        .param("nonce", "test-nonce")
                        .param("url", cssUri.toString()))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/live-reports/{id}/resource", sessionId)
                        .param("nonce", "test-nonce")
                        .param("url", scriptUri.toString()))
                .andExpect(status().isOk());

        verify(sessionService).recordResponseBytes(session, 3L);
        verify(sessionService).recordResponseBytes(session, 6L);
        verify(sessionService).recordResponseBytes(session, 4L);
        verify(sessionService).recordResponseBytes(session, 7L);
        verify(sessionService).recordResponseBytes(session, 5L);
        verify(sessionService).recordResponseBytes(session, 8L);
    }

    @Test
    void rejectsExpandedResponseBeforeItCanBeReturned() throws Exception {
        LiveReportFetchService.FetchedResource html = new LiveReportFetchService.FetchedResource(
                session.targetUri(), "text/html", new byte[3]
        );
        stubBudgetedFetch(session.targetUri(), html);
        when(rewriter.rewriteHtml(html, session)).thenReturn(new byte[9]);
        doThrow(new LiveReportException(
                HttpStatus.TOO_MANY_REQUESTS,
                "Live report session budget was exceeded"
        )).when(sessionService).recordResponseBytes(session, 6L);

        mockMvc.perform(get("/api/live-reports/{id}/document", sessionId).param("nonce", "test-nonce"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.message").value("Live report session budget was exceeded"));

        verify(sessionService).recordResponseBytes(session, 3L);
        verify(sessionService).recordResponseBytes(session, 6L);
    }

    @Test
    void shrinkingRewriteDoesNotRefundOrAddToTheRawTransferCharge() throws Exception {
        LiveReportFetchService.FetchedResource html = new LiveReportFetchService.FetchedResource(
                session.targetUri(), "text/html", new byte[9]
        );
        stubBudgetedFetch(session.targetUri(), html);
        when(rewriter.rewriteHtml(html, session)).thenReturn(new byte[3]);

        mockMvc.perform(get("/api/live-reports/{id}/document", sessionId).param("nonce", "test-nonce"))
                .andExpect(status().isOk())
                .andExpect(content().bytes(new byte[3]));

        verify(sessionService, times(1)).recordResponseBytes(eq(session), anyLong());
        verify(sessionService).recordResponseBytes(session, 9L);
    }

    @Test
    void returnsTooManyRequestsWhenSessionBudgetIsExhausted() throws Exception {
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenThrow(new LiveReportException(
                HttpStatus.TOO_MANY_REQUESTS,
                "Live report session budget was exceeded"
        ));

        mockMvc.perform(get("/api/live-reports/{id}/document", sessionId).param("nonce", "test-nonce"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.message").value("Live report session budget was exceeded"));
    }

    @Test
    void forwardsSafeBrowserRequestSemanticsAndPreservesUpstreamStatus() throws Exception {
        byte[] body = "missing upstream".getBytes(StandardCharsets.UTF_8);
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                404,
                URI.create("https://example.com/missing"),
                "text/plain",
                body
        );
        stubBudgetedFetch(session.targetUri(), fetched);

        mockMvc.perform(get("/api/live-reports/{id}/document", sessionId)
                        .param("nonce", "test-nonce")
                        .header("Accept", "text/html,application/xhtml+xml")
                        .header("Accept-Language", "fr-FR,fr;q=0.9")
                        .header("User-Agent", "Mozilla/5.0 Browser Under Test"))
                .andExpect(status().isNotFound())
                .andExpect(content().bytes(body))
                .andExpect(header().string("Referrer-Policy", "same-origin"));

        verify(fetchService).fetch(
                eq(session),
                eq(session.targetUri()),
                isNull(),
                argThat(headers -> headers.accept().equals("text/html,application/xhtml+xml")
                        && headers.acceptLanguage().equals("fr-FR,fr;q=0.9")
                        && headers.userAgent().equals("Mozilla/5.0 Browser Under Test"))
        );
        verify(sessionService).recordDocumentUri(session, fetched.finalUri());
    }

    @Test
    void mapsSameSessionProxyResourceReferrerBackToItsOwningUpstreamUrl() throws Exception {
        URI finalDocument = URI.create("https://example.com/app/final");
        URI resourceUri = URI.create("https://cdn.example.com/fonts/font.woff2");
        URI owningStylesheet = URI.create("https://cdn.example.com/styles/site.css");
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                resourceUri,
                "font/woff2",
                new byte[]{1, 2, 3}
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.documentUri(session)).thenReturn(Optional.of(finalDocument));
        when(sessionService.acquireRequest(session)).thenReturn(mock(LiveReportSessionService.RequestLease.class));
        when(fetchService.fetch(
                eq(session),
                eq(resourceUri),
                eq(owningStylesheet),
                any(LiveReportRequestHeaders.class)
        )).thenReturn(fetched);
        String proxyReferrer = "http://localhost/api/live-reports/" + sessionId
                + "/resource?nonce=test-nonce&url=https%3A%2F%2Fcdn.example.com%2Fstyles%2Fsite.css";

        mockMvc.perform(get("/api/live-reports/{id}/resource", sessionId)
                        .param("nonce", "test-nonce")
                        .param("url", resourceUri.toString())
                        .header("Referer", proxyReferrer))
                .andExpect(status().isOk())
                .andExpect(content().bytes(new byte[]{1, 2, 3}));

        verify(fetchService).fetch(
                eq(session),
                eq(resourceUri),
                eq(owningStylesheet),
                any(LiveReportRequestHeaders.class)
        );
    }

    @Test
    void ignoresReferrersThatAreNotBoundToTheSessionNonceAndUsesTheFinalDocument() throws Exception {
        URI finalDocument = URI.create("https://example.com/app/final");
        URI resourceUri = URI.create("https://example.com/app.js");
        LiveReportFetchService.FetchedResource fetched = new LiveReportFetchService.FetchedResource(
                resourceUri,
                "application/javascript",
                new byte[0]
        );
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.documentUri(session)).thenReturn(Optional.of(finalDocument));
        when(sessionService.acquireRequest(session)).thenReturn(mock(LiveReportSessionService.RequestLease.class));
        when(fetchService.fetch(
                eq(session),
                eq(resourceUri),
                eq(finalDocument),
                any(LiveReportRequestHeaders.class)
        )).thenReturn(fetched);
        when(rewriter.rewriteJavaScript(fetched, session)).thenReturn(new byte[0]);

        mockMvc.perform(get("/api/live-reports/{id}/resource", sessionId)
                        .param("nonce", "test-nonce")
                        .param("url", resourceUri.toString())
                        .header("Referer", "https://attacker.example/api/live-reports/" + sessionId
                                + "/resource?nonce=wrong-nonce&url=https%3A%2F%2Fattacker.example%2Ffake"))
                .andExpect(status().isOk());

        verify(fetchService).fetch(
                eq(session),
                eq(resourceUri),
                eq(finalDocument),
                any(LiveReportRequestHeaders.class)
        );
    }

    private void stubBudgetedFetch(URI uri, LiveReportFetchService.FetchedResource fetched) {
        when(sessionService.requireAuthorized(sessionId, "test-nonce")).thenReturn(session);
        when(sessionService.acquireRequest(session)).thenReturn(mock(LiveReportSessionService.RequestLease.class));
        URI referrer = uri.equals(session.targetUri()) ? null : session.targetUri();
        when(fetchService.fetch(
                eq(session),
                eq(uri),
                eq(referrer),
                any(LiveReportRequestHeaders.class)
        )).thenReturn(fetched);
    }
}
