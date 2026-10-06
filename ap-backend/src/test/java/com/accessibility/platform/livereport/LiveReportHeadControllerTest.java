package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.net.InetAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class LiveReportHeadControllerTest {
    private final LiveReportLaunchService launchService = mock(LiveReportLaunchService.class);
    private final LiveReportFetchService fetchService = mock(LiveReportFetchService.class);
    private final LiveReportDocumentRewriter rewriter = mock(LiveReportDocumentRewriter.class);
    private LiveReportSessionService sessionService;
    private LiveReportOriginRouteRegistry originRoutes;
    private LiveReportController controller;
    private LiveReportSessionService.LiveReportSession session;

    @BeforeEach
    void setUp() throws Exception {
        LiveReportProperties properties = new LiveReportProperties();
        InetAddress publicAddress = InetAddress.getByAddress(new byte[]{93, (byte) 184, (byte) 216, 34});
        LiveReportUrlSafetyValidator validator = new LiveReportUrlSafetyValidator(
                ignored -> List.of(publicAddress)
        );
        sessionService = new LiveReportSessionService(properties, validator);
        originRoutes = new LiveReportOriginRouteRegistry(sessionService, properties);
        controller = new LiveReportController(
                launchService,
                sessionService,
                fetchService,
                rewriter,
                properties,
                originRoutes
        );
        session = sessionService.create(41L, "https://example.com/page");
    }

    @Test
    void viewerHeadUsesUpstreamHeadAndNeverRewritesOrReturnsTheRepresentation() {
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(session, session.targetUri());
        LiveReportFetchService.FetchedResource fetched = htmlWithBody();
        when(fetchService.fetchHead(
                eq(session),
                eq(session.targetUri()),
                eq(null),
                any(LiveReportRequestHeaders.class)
        )).thenReturn(fetched);
        MockHttpServletRequest request = new MockHttpServletRequest("HEAD", "/page");
        request.setServerName(route.viewerOrigin().getHost());
        request.setServerPort(route.viewerOrigin().getPort());
        request.setAttribute(LiveReportViewerRoutingFilter.ROUTE_TOKEN_ATTRIBUTE, route.token());
        request.setAttribute(LiveReportViewerRoutingFilter.ORIGINAL_RAW_PATH_ATTRIBUTE, "/page");

        ResponseEntity<byte[]> response = controller.getViewerDocument(route.token(), request);

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getHeaders().getContentLength()).isZero();
        assertThat(response.getBody()).isEmpty();
        assertThat(response.getHeaders().getContentType()).hasToString("text/html;charset=UTF-8");
        verify(fetchService).fetchHead(
                eq(session),
                eq(session.targetUri()),
                eq(null),
                any(LiveReportRequestHeaders.class)
        );
        verify(fetchService, never()).fetch(
                any(LiveReportSessionService.LiveReportSession.class),
                any(URI.class),
                any(),
                any(LiveReportRequestHeaders.class)
        );
        verifyNoInteractions(rewriter);
        assertThat(sessionService.documentUri(session)).isEmpty();
    }

    @Test
    void compatibilityMirrorHeadUsesUpstreamHeadAndNeverRewritesOrReturnsTheRepresentation() {
        String mirror = LiveReportMirrorUrl.toRelativeUrl(session.id(), session.nonce(), session.targetUri());
        LiveReportMirrorUrl.DecodedMirrorRequest decoded = LiveReportMirrorUrl.decodeRequestPath(
                session.id(),
                session.nonce(),
                "",
                mirror,
                null
        );
        LiveReportFetchService.FetchedResource fetched = htmlWithBody();
        when(fetchService.fetchHead(
                eq(session),
                eq(session.targetUri()),
                eq(null),
                any(LiveReportRequestHeaders.class)
        )).thenReturn(fetched);
        MockHttpServletRequest request = new MockHttpServletRequest("HEAD", mirror);
        request.setRequestURI(mirror);

        ResponseEntity<byte[]> response = controller.getMirror(
                session.id(),
                session.nonce(),
                decoded.hostToken(),
                request
        );

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getHeaders().getContentLength()).isZero();
        assertThat(response.getBody()).isEmpty();
        verify(fetchService).fetchHead(
                eq(session),
                eq(session.targetUri()),
                eq(null),
                any(LiveReportRequestHeaders.class)
        );
        verifyNoInteractions(rewriter);
        assertThat(sessionService.documentUri(session)).isEmpty();
    }

    private LiveReportFetchService.FetchedResource htmlWithBody() {
        return new LiveReportFetchService.FetchedResource(
                session.targetUri(),
                "text/html",
                "must not be returned for HEAD".getBytes(StandardCharsets.UTF_8)
        );
    }
}
