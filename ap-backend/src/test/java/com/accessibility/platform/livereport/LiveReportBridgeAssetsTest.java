package com.accessibility.platform.livereport;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LiveReportBridgeAssetsTest {
    @Test
    void configurationCannotEndTheInlineScriptAndRoundTripsSpecialCharacters() throws Exception {
        String hostile = "</script><script>alert('x')</script>\\\"\n\u2028\u2029";
        String script = LiveReportBridgeAssets.script(new LiveReportBridgeAssets.Configuration(
                "session", hostile, "secret", "token", "https://example.com/", "https://example.com/",
                "http://localhost:9090", "http://localhost:9090", false, "X-Transport", 262144));
        int start = script.indexOf("const bridgeConfig = ") + "const bridgeConfig = ".length();
        String json = script.substring(start, script.indexOf(";\n", start));
        assertThat(json).doesNotContain("<", "\u2028", "\u2029");
        assertThat(new ObjectMapper().readTree(json).get("nonce").asText()).isEqualTo(hostile);
        assertThat(script).doesNotContain("</script>");
    }
}
