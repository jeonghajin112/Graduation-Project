package com.accessibility.platform.livereport;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Internal host router for the dedicated wildcard replay origin.
 *
 * <p>Every public path on a replay vhost, including {@code /api/**}, is mapped to one private
 * controller route before Spring MVC performs handler selection. The original raw path/query are
 * carried only in request attributes, so mirrored root-relative APIs cannot collide with the
 * platform's own API controllers.</p>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
@RequiredArgsConstructor
public class LiveReportViewerRoutingFilter extends OncePerRequestFilter {
    static final String ORIGINAL_RAW_PATH_ATTRIBUTE =
            LiveReportViewerRoutingFilter.class.getName() + ".originalRawPath";
    static final String ROUTE_TOKEN_ATTRIBUTE =
            LiveReportViewerRoutingFilter.class.getName() + ".routeToken";
    static final String INTERNAL_ROUTE_PREFIX = "/__live-replay/";

    private final LiveReportOriginRouteRegistry originRoutes;

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        if (!originRoutes.isViewerZoneHost(request.getServerName())) {
            filterChain.doFilter(request, response);
            return;
        }

        String token;
        try {
            token = originRoutes.viewerRouteToken(request.getServerName());
        } catch (LiveReportException exception) {
            response.setStatus(HttpServletResponse.SC_NOT_FOUND);
            response.setHeader("Cache-Control", "no-store");
            response.setContentLength(0);
            return;
        }
        String rawRequestPath = request.getRequestURI();
        String contextPath = request.getContextPath();
        String rawUpstreamPath = contextPath == null || contextPath.isEmpty()
                ? rawRequestPath
                : rawRequestPath.startsWith(contextPath)
                ? rawRequestPath.substring(contextPath.length())
                : rawRequestPath;
        request.setAttribute(ORIGINAL_RAW_PATH_ATTRIBUTE, rawUpstreamPath);
        request.setAttribute(ROUTE_TOKEN_ATTRIBUTE, token);

        String internalPath = (contextPath == null ? "" : contextPath)
                + INTERNAL_ROUTE_PREFIX + token;
        HttpServletRequestWrapper routed = new HttpServletRequestWrapper(request) {
            @Override
            public String getRequestURI() {
                return internalPath;
            }

            @Override
            public String getServletPath() {
                return INTERNAL_ROUTE_PREFIX + token;
            }

            @Override
            public String getPathInfo() {
                return null;
            }

            @Override
            public StringBuffer getRequestURL() {
                String port = (getScheme().equals("http") && getServerPort() == 80)
                        || (getScheme().equals("https") && getServerPort() == 443)
                        ? ""
                        : ":" + getServerPort();
                return new StringBuffer(getScheme() + "://" + getServerName() + port + internalPath);
            }
        };
        filterChain.doFilter(routed, response);
    }
}
