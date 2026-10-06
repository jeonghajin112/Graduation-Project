package com.accessibility.platform.livereport.config;

import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.stereotype.Component;

/**
 * Preserves encoded upstream path separators until the live-report host router can bind the
 * request to its session origin. Tomcat rejects {@code %2F} by default, which would otherwise
 * make path-preserving replay URLs unusable for APIs that intentionally encode a slash inside a
 * path segment. Encoded reverse solidus remains rejected to avoid ambiguous path interpretation.
 */
@Component
public class LiveReportTomcatConnectorCustomizer
        implements WebServerFactoryCustomizer<TomcatServletWebServerFactory> {

    @Override
    public void customize(TomcatServletWebServerFactory factory) {
        factory.addConnectorCustomizers(connector -> {
            connector.setEncodedSolidusHandling("passthrough");
            connector.setEncodedReverseSolidusHandling("reject");
        });
    }
}
