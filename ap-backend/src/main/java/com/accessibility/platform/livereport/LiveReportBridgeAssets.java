package com.accessibility.platform.livereport;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Assembles private bridge modules into one early, inline script, without
 * introducing requests to the inspected site's origin or exposing globals. */
final class LiveReportBridgeAssets {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String STYLES = read("bridge.css");
    private static final String MODULES = read("locator-resolver.js") + "\n"
            + read("marker-clusters.js") + "\n" + read("popover-view.js") + "\n"
            + read("bridge-runtime.js");

    private LiveReportBridgeAssets() { }

    static String styles() { return STYLES; }

    static String script(Configuration configuration) {
        try {
            // HTML parsers recognize closing script tags even inside JS strings.
            String config = JSON.writeValueAsString(configuration)
                    .replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
            return "(() => { 'use strict'; const bridgeConfig = " + config + ";\n" + MODULES + "\n})();";
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialize live report configuration", e);
        }
    }

    private static String read(String name) {
        try (var stream = LiveReportBridgeAssets.class.getResourceAsStream("/livereport/" + name)) {
            if (stream == null) throw new IllegalStateException("Missing live report asset: " + name);
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("Could not read live report asset: " + name, e);
        }
    }

    record Configuration(String sessionId, String nonce, String bridgeSecret, String documentToken,
                         String upstreamBase, String upstreamDocument, String gatewayOrigin,
                         String viewerBaseOrigin, boolean hasExplicitBase,
                         String transportHeader, int maxRequestBodyBytes) { }
}
