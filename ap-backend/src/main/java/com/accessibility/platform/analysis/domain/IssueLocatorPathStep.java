package com.accessibility.platform.analysis.domain;

public record IssueLocatorPathStep(
        String context,
        String selector,
        String frameUrl
) {
}
