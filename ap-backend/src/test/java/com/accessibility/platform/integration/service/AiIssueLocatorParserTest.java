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
                    "htmlSnippet": "<button class=save>Save</button>",
                    "carouselContext": {
                      "carouselId": 2,
                      "slideIndex": 1,
                      "slideCount": 4
                    }
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
        assertThat(locator.carouselContext()).isNotNull();
        assertThat(locator.carouselContext().carouselId()).isEqualTo(2);
        assertThat(locator.carouselContext().slideIndex()).isEqualTo(1);
        assertThat(locator.carouselContext().slideCount()).isEqualTo(4);
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
        assertThat(locator.carouselContext()).isNull();
    }

    @Test
    void ignoresMalformedCarouselContextWithoutDroppingTheLocator() throws Exception {
        for (String malformedContext : java.util.List.of(
                "{\"carouselId\":0,\"slideIndex\":0,\"slideCount\":2}",
                "{\"carouselId\":1,\"slideIndex\":2,\"slideCount\":2}",
                "{\"carouselId\":1,\"slideIndex\":0.5,\"slideCount\":2}",
                "{\"carouselId\":\"1\",\"slideIndex\":0,\"slideCount\":2}",
                "{\"carouselId\":1,\"slideIndex\":0,\"slideCount\":10001}",
                "{\"carouselId\":1,\"slideIndex\":0,\"slideCount\":2147483648}"
        )) {
            JsonNode node = objectMapper.readTree("""
                    {
                      "selector": "button.save",
                      "locator": {
                        "pathSteps": [{"context":"document","selector":"button.save"}],
                        "carouselContext": %s
                      }
                    }
                    """.formatted(malformedContext));

            IssueLocator locator = parser.fromRuleNode(node);

            assertThat(locator).isNotNull();
            assertThat(locator.pathSteps()).hasSize(1);
            assertThat(locator.carouselContext()).isNull();
        }
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
        assertThat(locator.carouselContext()).isNull();
    }
}
