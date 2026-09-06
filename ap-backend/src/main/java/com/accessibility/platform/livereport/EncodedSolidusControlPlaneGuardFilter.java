package com.accessibility.platform.livereport;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Contains Tomcat's encoded-solidus passthrough exception to dedicated replay viewer hosts.
 *
 * <p>The connector has to preserve {@code %2F} so an upstream path can be replayed byte for byte.
 * That connector option is necessarily server-wide, however, so control-plane/API hosts must be
 * rejected before Spring MVC performs handler selection. Viewer-zone hosts continue to the viewer
 * router, which validates the route-token label and fails unknown or malformed hosts closed.</p>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
@RequiredArgsConstructor
public class EncodedSolidusControlPlaneGuardFilter extends OncePerRequestFilter {
    private final LiveReportOriginRouteRegistry originRoutes;

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        if (containsEncodedSolidus(request.getRequestURI())
                && !originRoutes.isViewerZoneHost(request.getServerName())) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            response.setHeader("Cache-Control", "no-store");
            response.setContentLength(0);
            return;
        }
        filterChain.doFilter(request, response);
    }

    private boolean containsEncodedSolidus(String rawRequestUri) {
        if (rawRequestUri == null || rawRequestUri.length() < 3) {
            return false;
        }
        for (int index = 0; index <= rawRequestUri.length() - 3; index++) {
            if (rawRequestUri.charAt(index) == '%'
                    && rawRequestUri.charAt(index + 1) == '2') {
                char finalNibble = rawRequestUri.charAt(index + 2);
                if (finalNibble == 'f' || finalNibble == 'F') {
                    return true;
                }
            }
        }
        return false;
    }
}
