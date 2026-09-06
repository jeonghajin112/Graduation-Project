package com.accessibility.platform.common.config;

import com.accessibility.platform.livereport.LiveReportOriginRouteRegistry;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.Arrays;

@Configuration
public class CorsConfig implements WebMvcConfigurer {

    private static final String[] DASHBOARD_ORIGIN_PATTERNS = {
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "https://uniaccess.pages.dev",
            "https://*.trycloudflare.com"
    };

    private final LiveReportOriginRouteRegistry liveReportOrigins;

    public CorsConfig(LiveReportOriginRouteRegistry liveReportOrigins) {
        this.liveReportOrigins = liveReportOrigins;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        String[] dashboardOrigins = dashboardOriginPatterns();

        registry.addMapping("/api/**")
                .allowedOriginPatterns(dashboardOrigins)
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(false);
    }

    private String[] dashboardOriginPatterns() {
        String[] origins = Arrays.copyOf(
                DASHBOARD_ORIGIN_PATTERNS,
                DASHBOARD_ORIGIN_PATTERNS.length + 1
        );
        origins[origins.length - 1] = liveReportOrigins.dashboardOrigin();
        return origins;
    }
}
