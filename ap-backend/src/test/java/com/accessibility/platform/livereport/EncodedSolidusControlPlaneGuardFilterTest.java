package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class EncodedSolidusControlPlaneGuardFilterTest {
    private EncodedSolidusControlPlaneGuardFilter filter;

    @BeforeEach
    void setUp() {
        LiveReportProperties properties = new LiveReportProperties();
        properties.setViewerBaseUrl("http://localhost:9090");
        LiveReportSessionService sessionService = mock(LiveReportSessionService.class);
        LiveReportOriginRouteRegistry originRoutes =
                new LiveReportOriginRouteRegistry(sessionService, properties);
        filter = new EncodedSolidusControlPlaneGuardFilter(originRoutes);
    }

    @Test
    void rejectsEncodedSolidusOnControlPlaneHostBeforeTheFilterChain() throws Exception {
        MockHttpServletRequest request = request("localhost", "/api/results/%2Fadmin");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(400);
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
        assertThat(response.getContentLength()).isZero();
        verify(chain, never()).doFilter(request, response);
    }

    @Test
    void rejectsEncodedSolidusCaseInsensitively() throws Exception {
        MockHttpServletRequest request = request("api.example.test", "/api/results/%2fadmin");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(400);
        verify(chain, never()).doFilter(request, response);
    }

    @Test
    void permitsEncodedSolidusOnlyIntoTheViewerZoneRouter() throws Exception {
        MockHttpServletRequest request = request(
                "0123456789abcdef0123456789abcdef01234567.localhost",
                "/api/items/%2Fdetail"
        );
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        verify(chain).doFilter(request, response);
    }

    @Test
    void leavesMalformedViewerZoneHostForTheFailClosedViewerRouter() throws Exception {
        MockHttpServletRequest request = request("not-a-route.localhost", "/api/items/%2Fdetail");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        verify(chain).doFilter(request, response);
    }

    @Test
    void doesNotAffectOrdinaryControlPlanePathsOrEncodedQueryValues() throws Exception {
        MockHttpServletRequest request = request("localhost", "/api/results/requests");
        request.setQueryString("return=%2Fdashboard");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        verify(chain).doFilter(request, response);
    }

    private MockHttpServletRequest request(String host, String requestUri) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", requestUri);
        request.setServerName(host);
        request.setServerPort(9090);
        return request;
    }
}
