package com.accessibility.platform.livereport;

import jakarta.servlet.http.HttpServletRequest;

import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

/** Identifies requests issued by the injected fetch/XMLHttpRequest bridge. */
final class LiveReportTransport {
    static final String HEADER_NAME = "X-Accessibility-Live-Transport";
    static final String FETCH = "fetch";
    static final String XHR = "xhr";

    private LiveReportTransport() {
    }

    static boolean isProgrammatic(HttpServletRequest request) {
        Enumeration<String> headers = request.getHeaders(HEADER_NAME);
        if (headers == null) {
            return false;
        }
        List<String> values = Collections.list(headers);
        return values.size() == 1 && (FETCH.equals(values.getFirst()) || XHR.equals(values.getFirst()));
    }
}
