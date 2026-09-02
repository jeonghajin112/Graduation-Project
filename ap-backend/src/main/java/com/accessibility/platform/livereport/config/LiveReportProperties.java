package com.accessibility.platform.livereport.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Getter
@Setter
@Component
@ConfigurationProperties(prefix = "accessibility.live-report")
public class LiveReportProperties {
    /**
     * Dedicated wildcard origin used only by mirrored pages. Production must
     * route *.viewer-base-url to this service with wildcard DNS and TLS.
     */
    private String viewerBaseUrl = "http://localhost:9090";
    /**
     * Stable API origin used for the session broker. It must not be derived
     * from an inbound Host or Forwarded header.
     */
    private String gatewayBaseUrl = "http://localhost:9090";
    /** Exact dashboard origin allowed to embed the replay viewer. */
    private String dashboardBaseUrl = "http://localhost:5173";
    private int sessionTtlSeconds = 300;
    private int maxSessions = 64;
    private int maxOriginsPerSession = 64;
    private int connectTimeoutSeconds = 3;
    private int requestTimeoutSeconds = 10;
    private int maxRedirects = 4;
    private int maxRequestBodyBytes = 256 * 1024;
    private int maxResponseBytes = 5 * 1024 * 1024;
    /**
     * Images, fonts and other opaque browser resources are commonly larger
     * than HTML/CSS/JavaScript. Keep their allowance separate so raising it
     * cannot silently broaden the executable-document limit.
     */
    private int maxOpaqueResponseBytes = 16 * 1024 * 1024;
    private int maxRewrittenResponseBytes = 16 * 1024 * 1024;
    private int maxRequestsPerSession = 1024;
    private long maxBytesPerSession = 256L * 1024L * 1024L;
    private int maxConcurrentRequestsPerSession = 24;
    private int concurrentRequestWaitMillis = 10_000;
    private int maxCookiesPerSession = 64;
    private int maxCookieBytes = 4096;
    private int maxCookieBytesPerSession = 32 * 1024;

    public int responseLimitBytes(String contentType) {
        String essence = contentType == null
                ? ""
                : contentType.strip().toLowerCase(java.util.Locale.ROOT).split(";", 2)[0].strip();
        boolean opaque = essence.startsWith("image/")
                || essence.startsWith("audio/")
                || essence.startsWith("video/")
                || essence.startsWith("font/")
                || essence.startsWith("application/font-")
                || essence.startsWith("application/x-font-")
                || essence.equals("application/vnd.ms-fontobject")
                || essence.equals("application/octet-stream")
                || essence.equals("application/wasm");
        return Math.max(0, opaque ? maxOpaqueResponseBytes : maxResponseBytes);
    }
}
