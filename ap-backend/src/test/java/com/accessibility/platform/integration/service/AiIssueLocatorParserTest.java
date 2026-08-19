package com.accessibility.platform.integration.service;

import com.accessibility.platform.analysis.domain.IssueLocator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AiIssueLocatorParserTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final AiIssueLocatorParser parser = new AiIssueLocatorParser();

    @Test
    void preservesExplicitTypedRuleLocator() throws Exception {
        JsonNode node = objectMapper.readTree("""
                {
                  "selector": "#legacy",
                  "html": "<button id=legacy>Save</button>",
                  "locator": {
                    "kind": "DOM_RECT",
                    "pathSteps": [
                      {"context":"document","selector":"iframe#app","frameUrl":"https://example.com/"},
                      {"context":"iframe","selector":"button.save","frameUrl":"https://frame.example/"}
                    ],
                    "x": 12.5,
                    "y": 24,
                    "width": 80,
                    "height": 32,
                    "coordinateSpace": "DOCUMENT_CSS_PX",
                    "visible": false,
                    "htmlSnippet": "<button class=save>Save</button>"
                  }
                }
                """);

        IssueLocator locator = parser.fromRuleNode(node);

        assertThat(locator.kind()).isEqualTo("DOM_RECT");
        assertThat(locator.pathSteps()).hasSize(2);
        assertThat(locator.pathSteps().get(1).context()).isEqualTo("iframe");
        assertThat(locator.pathSteps().get(1).frameUrl()).isEqualTo("https://frame.example/");
        assertThat(locator.x()).isEqualTo(12.5);
        assertThat(locator.visible()).isFalse();
        assertThat(locator.htmlSnippet()).contains("button class");
    }

    @Test
    void buildsBackwardCompatibleLocatorFromLegacySelectorAndHtml() throws Exception {
        JsonNode node = objectMapper.readTree("""
                {"selector":"main > img.hero","html":"<img class=hero>"}
                """);

        IssueLocator locator = parser.fromRuleNode(node);

        assertThat(locator.kind()).isEqualTo("CSS_SELECTOR");
        assertThat(locator.pathSteps()).containsExactly(
                new com.accessibility.platform.analysis.domain.IssueLocatorPathStep(
                        "DOCUMENT",
                        "main > img.hero",
                        null
                )
        );
        assertThat(locator.htmlSnippet()).isEqualTo("<img class=hero>");
        assertThat(locator.coordinateSpace()).isNull();
    }

    @Test
    void mapsCvLocationToScreenshotPixelBoundingBox() throws Exception {
        JsonNode violation = objectMapper.readTree("""
                {"location":{"x":100,"y":200,"width":80,"height":24}}
                """);

        IssueLocator locator = parser.fromCvViolation(violation);

        assertThat(locator.kind()).isEqualTo("BOUNDING_BOX");
        assertThat(locator.coordinateSpace()).isEqualTo("SCREENSHOT_PX");
        assertThat(locator.visible()).isTrue();
        assertThat(locator.x()).isEqualTo(100.0);
        assertThat(locator.height()).isEqualTo(24.0);
    }
}
