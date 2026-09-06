package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.net.URI;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class LiveReportViewerRoutingFilterTest {
    private static final Instant NOW = Instant.parse("2026-09-02T00:00:00Z");
    private final LiveReportSessionService sessionService = mock(LiveReportSessionService.class);
    private final LiveReportProperties properties = new LiveReportProperties();
    private final LiveReportSessionService.LiveReportSession session =
            new LiveReportSessionService.LiveReportSession(
                    UUID.fromString("6b2d884e-a7f4-4f09-9776-688d08fe8912"),
                    7L,
                    URI.create("https://example.com/app/start"),
                    "test-nonce",
                    "test-bridge-secret",
                    NOW.plusSeconds(300)
            );
    private LiveReportOriginRouteRegistry originRoutes;
    private LiveReportViewerRoutingFilter filter;

    @BeforeEach
    void setUp() {
        originRoutes = new LiveReportOriginRouteRegistry(
                sessionService,
                properties,
                Clock.fixed(NOW, ZoneOffset.UTC)
        );
        filter = new LiveReportViewerRoutingFilter(originRoutes);
    }

    @Test
    void rewritesEveryPathOnAViewerHostToThePrivateControllerRoute() throws Exception {
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(
                session,
                URI.create("https://example.com/app/start")
        );
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/items/%2Fdetail");
        request.setScheme("http");
        request.setServerName(route.viewerOrigin().getHost());
        request.setServerPort(9090);
        request.setQueryString("page=1&return=%2Fhome");
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        HttpServletRequest routed = (HttpServletRequest) chain.getRequest();
        assertThat(routed).isNotNull();
        assertThat(routed.getRequestURI())
                .isEqualTo(LiveReportViewerRoutingFilter.INTERNAL_ROUTE_PREFIX + route.token());
        assertThat(routed.getServletPath())
                .isEqualTo(LiveReportViewerRoutingFilter.INTERNAL_ROUTE_PREFIX + route.token());
        assertThat(routed.getQueryString()).isEqualTo("page=1&return=%2Fhome");
        assertThat(routed.getAttribute(LiveReportViewerRoutingFilter.ORIGINAL_RAW_PATH_ATTRIBUTE))
                .isEqualTo("/api/items/%2Fdetail");
        assertThat(routed.getAttribute(LiveReportViewerRoutingFilter.ROUTE_TOKEN_ATTRIBUTE))
                .isEqualTo(route.token());
        assertThat(routed.getRequestURL().toString()).isEqualTo(
                route.viewerOrigin() + LiveReportViewerRoutingFilter.INTERNAL_ROUTE_PREFIX + route.token()
        );
    }

    @Test
    void leavesTheGatewayHostAndItsPlatformApiPathsUntouched() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/results/requests/7");
        request.setScheme("http");
        request.setServerName("localhost");
        request.setServerPort(9090);
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, new MockHttpServletResponse(), chain);

        assertThat(chain.getRequest()).isSameAs(request);
        assertThat(((HttpServletRequest) chain.getRequest()).getRequestURI())
                .isEqualTo("/api/results/requests/7");
        assertThat(request.getAttribute(LiveReportViewerRoutingFilter.ROUTE_TOKEN_ATTRIBUTE)).isNull();
    }

    @Test
    void rejectsMalformedViewerZoneHostsBeforeTheyReachTheMvcChain() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/results/requests/7");
        request.setScheme("http");
        request.setServerName("unknown-token.localhost");
        request.setServerPort(9090);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(404);
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
        assertThat(response.getContentAsByteArray()).isEmpty();
        assertThat(chain.getRequest()).isNull();
    }

    @Test
    void normalizesASingleTrailingDnsRootDotOnViewerHosts() throws Exception {
        LiveReportOriginRouteRegistry.RoutedOrigin route = originRoutes.routeFor(
                session,
                URI.create("https://example.com/app/start")
        );
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/app/start");
        request.setScheme("http");
        request.setServerName(route.viewerOrigin().getHost() + ".");
        request.setServerPort(9090);
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, new MockHttpServletResponse(), chain);

        HttpServletRequest routed = (HttpServletRequest) chain.getRequest();
        assertThat(routed).isNotNull();
        assertThat(routed.getAttribute(LiveReportViewerRoutingFilter.ROUTE_TOKEN_ATTRIBUTE))
                .isEqualTo(route.token());
        assertThat(routed.getRequestURI())
                .isEqualTo(LiveReportViewerRoutingFilter.INTERNAL_ROUTE_PREFIX + route.token());
    }
}
