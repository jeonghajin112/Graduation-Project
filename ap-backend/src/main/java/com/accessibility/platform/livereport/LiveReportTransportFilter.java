package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Rejects browser transports that could otherwise be parsed as multipart data before MVC reaches
 * the live-report controller. The controller repeats the transport check as defense in depth.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
@RequiredArgsConstructor
public class LiveReportTransportFilter extends OncePerRequestFilter {
    private final LiveReportProperties properties;

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        if (!isMirrorPost(request)) {
            filterChain.doFilter(request, response);
            return;
        }

        if (!LiveReportTransport.isProgrammatic(request)) {
            reject(response, HttpStatus.FORBIDDEN, "Live report POST requests require fetch or XMLHttpRequest");
            return;
        }
        if (isMultipart(request.getContentType())) {
            reject(response, HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Live report multipart requests are not allowed");
            return;
        }
        if (request.getContentLengthLong() > Math.max(0, properties.getMaxRequestBodyBytes())) {
            reject(response, HttpStatus.CONTENT_TOO_LARGE, "Live report request exceeds the configured size limit");
            return;
        }

        filterChain.doFilter(request, response);
    }

    private boolean isMirrorPost(HttpServletRequest request) {
        if (!"POST".equalsIgnoreCase(request.getMethod())) {
            return false;
        }
        String path = request.getRequestURI();
        String prefix = request.getContextPath() + "/api/live-reports/";
        String viewerPrefix = request.getContextPath() + LiveReportViewerRoutingFilter.INTERNAL_ROUTE_PREFIX;
        return path.startsWith(viewerPrefix)
                || (path.startsWith(prefix) && path.indexOf("/mirror/", prefix.length()) >= 0);
    }

    private boolean isMultipart(String contentType) {
        if (contentType == null) {
            return false;
        }
        String essence = contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return essence.startsWith("multipart/");
    }

    private void reject(HttpServletResponse response, HttpStatus status, String message) throws IOException {
        response.setStatus(status.value());
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.getWriter().write("{\"success\":false,\"data\":null,\"message\":\"" + message + "\"}");
    }
}
