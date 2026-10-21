package com.accessibility.platform.livereport;

import jakarta.servlet.http.HttpServletRequest;

import java.nio.charset.StandardCharsets;

/** Safe request semantics, with a desktop identity matching the analyzed page. */
public record LiveReportRequestHeaders(
        String accept,
        String acceptLanguage,
        String userAgent,
        String upstreamOrigin
) {
    private static final int MAX_ACCEPT_BYTES = 1024;
    private static final int MAX_ACCEPT_LANGUAGE_BYTES = 512;
    private static final String DEFAULT_ACCEPT = "*/*";
    private static final String DEFAULT_ACCEPT_LANGUAGE = "ko-KR,ko;q=0.9,en;q=0.8";
    static final String DESKTOP_USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

    public LiveReportRequestHeaders {
        accept = sanitize(accept, MAX_ACCEPT_BYTES, DEFAULT_ACCEPT);
        acceptLanguage = sanitize(acceptLanguage, MAX_ACCEPT_LANGUAGE_BYTES, DEFAULT_ACCEPT_LANGUAGE);
        // Results were collected on desktop. A phone UA can redirect the viewer
        // to another document with different elements and invalidate its markers.
        userAgent = DESKTOP_USER_AGENT;
        upstreamOrigin = sanitizeOptional(upstreamOrigin, 2048);
    }

    public LiveReportRequestHeaders(String accept, String acceptLanguage, String userAgent) {
        this(accept, acceptLanguage, userAgent, null);
    }

    public static LiveReportRequestHeaders from(HttpServletRequest request) {
        return new LiveReportRequestHeaders(
                request.getHeader("Accept"),
                request.getHeader("Accept-Language"),
                DESKTOP_USER_AGENT,
                null
        );
    }

    public static LiveReportRequestHeaders defaults() {
        return new LiveReportRequestHeaders(null, null, null, null);
    }

    public LiveReportRequestHeaders withUpstreamOrigin(String origin) {
        return new LiveReportRequestHeaders(accept, acceptLanguage, userAgent, origin);
    }

    private static String sanitize(String value, int maxBytes, String fallback) {
        if (value == null) {
            return fallback;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()
                || trimmed.getBytes(StandardCharsets.UTF_8).length > maxBytes
                || trimmed.chars().anyMatch(character -> character < 0x20 || character == 0x7f)) {
            return fallback;
        }
        return trimmed;
    }

    private static String sanitizeOptional(String value, int maxBytes) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()
                || trimmed.getBytes(StandardCharsets.UTF_8).length > maxBytes
                || trimmed.chars().anyMatch(character -> character < 0x20 || character == 0x7f)) {
            return null;
        }
        return trimmed;
    }
}
