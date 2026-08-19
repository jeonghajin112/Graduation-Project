package com.accessibility.platform.integration.service;

import com.accessibility.platform.analysis.domain.IssueLocator;
import com.accessibility.platform.analysis.domain.IssueLocatorPathStep;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

@Component
public class AiIssueLocatorParser {

    private static final int MAX_PATH_STEPS = 32;
    private static final int MAX_SELECTOR_LENGTH = 8_000;
    private static final int MAX_FRAME_URL_LENGTH = 2_048;
    private static final int MAX_HTML_SNIPPET_LENGTH = 32_000;

    public IssueLocator fromRuleNode(JsonNode node) {
        return parseNode(node, "DOCUMENT_CSS_PX");
    }

    public IssueLocator fromTextBlock(JsonNode block) {
        return parseNode(block, "DOCUMENT_CSS_PX");
    }

    public IssueLocator fromCvViolation(JsonNode violation) {
        JsonNode explicitLocator = violation.path("locator");
        JsonNode location = explicitLocator.isObject() ? explicitLocator : violation.path("location");
        if (!location.isObject()) {
            return null;
        }

        Double x = finiteNumber(location, "x");
        Double y = finiteNumber(location, "y");
        Double width = nonNegativeNumber(location, "width");
        Double height = nonNegativeNumber(location, "height");
        if (x == null && y == null && width == null && height == null) {
            return null;
        }

        return new IssueLocator(
                text(location, "kind", "BOUNDING_BOX"),
                pathSteps(location, null),
                x,
                y,
                width,
                height,
                firstText(location, "coordinateSpace", "coordinate_space", "SCREENSHOT_PX"),
                booleanValue(location, "visible", true),
                bounded(firstText(location, "htmlSnippet", "html_snippet", null), MAX_HTML_SNIPPET_LENGTH)
        );
    }

    private IssueLocator parseNode(JsonNode node, String defaultCoordinateSpace) {
        JsonNode explicitLocator = node.path("locator");
        JsonNode source = explicitLocator.isObject() ? explicitLocator : node;
        JsonNode rect = source.path("rect").isObject() ? source.path("rect") : source;

        String legacySelector = bounded(text(node, "selector", null), MAX_SELECTOR_LENGTH);
        List<IssueLocatorPathStep> pathSteps = pathSteps(source, legacySelector);
        Double x = finiteNumber(rect, "x");
        Double y = finiteNumber(rect, "y");
        Double width = nonNegativeNumber(rect, "width");
        Double height = nonNegativeNumber(rect, "height");
        String htmlSnippet = bounded(
                firstNonBlank(
                        firstText(source, "htmlSnippet", "html_snippet", null),
                        text(node, "html", null)
                ),
                MAX_HTML_SNIPPET_LENGTH
        );

        if (pathSteps.isEmpty()
                && x == null && y == null && width == null && height == null
                && htmlSnippet == null) {
            return null;
        }

        boolean hasBox = x != null || y != null || width != null || height != null;
        String defaultKind = pathSteps.isEmpty() ? "BOUNDING_BOX" : "CSS_SELECTOR";
        return new IssueLocator(
                text(source, "kind", defaultKind),
                pathSteps,
                x,
                y,
                width,
                height,
                firstText(source, "coordinateSpace", "coordinate_space", hasBox ? defaultCoordinateSpace : null),
                nullableBoolean(source, "visible"),
                htmlSnippet
        );
    }

    private List<IssueLocatorPathStep> pathSteps(JsonNode locator, String fallbackSelector) {
        JsonNode stepsNode = locator.path("pathSteps");
        if (!stepsNode.isArray()) {
            stepsNode = locator.path("path_steps");
        }

        List<IssueLocatorPathStep> steps = new ArrayList<>();
        if (stepsNode.isArray()) {
            for (JsonNode step : stepsNode) {
                if (steps.size() >= MAX_PATH_STEPS) {
                    break;
                }
                if (step.isTextual()) {
                    String selector = bounded(blankToNull(step.asText()), MAX_SELECTOR_LENGTH);
                    if (selector != null) {
                        steps.add(new IssueLocatorPathStep("DOCUMENT", selector, null));
                    }
                    continue;
                }
                if (!step.isObject()) {
                    continue;
                }
                String context = bounded(text(step, "context", "DOCUMENT"), 80);
                String selector = bounded(text(step, "selector", null), MAX_SELECTOR_LENGTH);
                String frameUrl = bounded(firstText(step, "frameUrl", "frame_url", null), MAX_FRAME_URL_LENGTH);
                if (selector != null || frameUrl != null || context != null) {
                    steps.add(new IssueLocatorPathStep(context, selector, frameUrl));
                }
            }
        }

        if (steps.isEmpty() && fallbackSelector != null) {
            steps.add(new IssueLocatorPathStep("DOCUMENT", fallbackSelector, null));
        }
        return steps;
    }

    private Double finiteNumber(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull() || (!value.isNumber() && !value.isTextual())) {
            return null;
        }
        try {
            double number = value.asDouble(Double.NaN);
            return Double.isFinite(number) ? number : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private Double nonNegativeNumber(JsonNode node, String field) {
        Double value = finiteNumber(node, field);
        return value != null && value >= 0 ? value : null;
    }

    private Boolean nullableBoolean(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isBoolean() ? value.asBoolean() : null;
    }

    private Boolean booleanValue(JsonNode node, String field, boolean defaultValue) {
        Boolean value = nullableBoolean(node, field);
        return value == null ? defaultValue : value;
    }

    private String text(JsonNode node, String field, String defaultValue) {
        JsonNode value = node.path(field);
        if (!value.isTextual()) {
            return defaultValue;
        }
        String text = blankToNull(value.asText());
        return text == null ? defaultValue : text;
    }

    private String firstText(JsonNode node, String firstField, String secondField, String defaultValue) {
        return firstNonBlank(text(node, firstField, null), text(node, secondField, null), defaultValue);
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            String normalized = blankToNull(value);
            if (normalized != null) {
                return normalized;
            }
        }
        return null;
    }

    private String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private String bounded(String value, int maxLength) {
        String normalized = blankToNull(value);
        if (normalized == null || normalized.length() <= maxLength) {
            return normalized;
        }
        return normalized.substring(0, maxLength);
    }
}
