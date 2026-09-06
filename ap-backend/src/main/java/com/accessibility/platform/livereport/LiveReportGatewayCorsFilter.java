package com.accessibility.platform.livereport;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Collections;
import java.util.Enumeration;

/**
 * Keeps Spring's platform-wide CORS mapping from granting replay gateway reads.
 *
 * <p>The live-report controller translates the browser replay origin back to its bound upstream
 * origin and evaluates the upstream response's CORS policy. Hiding the untrusted browser Origin
 * from the generic MVC CORS processor prevents it from pre-authorizing the response before that
 * check runs. The original value remains available only through a private request attribute.</p>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 15)
public class LiveReportGatewayCorsFilter extends OncePerRequestFilter {
    static final String BROWSER_ORIGIN_ATTRIBUTE =
            LiveReportGatewayCorsFilter.class.getName() + ".browserOrigin";

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        var browserOrigins = Collections.list(request.getHeaders("Origin"));
        boolean originHeaderPresent = !browserOrigins.isEmpty() || request.getHeader("Origin") != null;
        if (!originHeaderPresent || !isLiveReportGateway(request)) {
            filterChain.doFilter(request, response);
            return;
        }

        String browserOrigin = browserOrigins.size() == 1 ? browserOrigins.get(0) : "";
        request.setAttribute(BROWSER_ORIGIN_ATTRIBUTE, browserOrigin);
        HttpServletRequestWrapper withoutOrigin = new HttpServletRequestWrapper(request) {
            @Override
            public String getHeader(String name) {
                return "Origin".equalsIgnoreCase(name) ? null : super.getHeader(name);
            }

            @Override
            public Enumeration<String> getHeaders(String name) {
                return "Origin".equalsIgnoreCase(name)
                        ? Collections.emptyEnumeration()
                        : super.getHeaders(name);
            }

            @Override
            public Enumeration<String> getHeaderNames() {
                return Collections.enumeration(Collections.list(super.getHeaderNames()).stream()
                        .filter(name -> !"Origin".equalsIgnoreCase(name))
                        .toList());
            }
        };
        filterChain.doFilter(withoutOrigin, response);
    }

    static String browserOrigin(HttpServletRequest request) {
        Object captured = request.getAttribute(BROWSER_ORIGIN_ATTRIBUTE);
        if (captured instanceof String value) {
            return value;
        }
        var origins = Collections.list(request.getHeaders("Origin"));
        return origins.size() == 1 ? origins.get(0) : null;
    }

    private boolean isLiveReportGateway(HttpServletRequest request) {
        String path = request.getRequestURI();
        String prefix = request.getContextPath() + "/api/live-reports/";
        if (!path.startsWith(prefix)) {
            return false;
        }
        int routeEnd = path.indexOf('/', prefix.length());
        if (routeEnd < 0) {
            return false;
        }
        String endpoint = path.substring(routeEnd);
        return endpoint.equals("/document")
                || endpoint.equals("/resource")
                || endpoint.startsWith("/mirror/");
    }
}
