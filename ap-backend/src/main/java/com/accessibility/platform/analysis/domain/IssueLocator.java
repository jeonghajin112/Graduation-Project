package com.accessibility.platform.analysis.domain;

import java.util.List;

public record IssueLocator(
        String kind,
        List<IssueLocatorPathStep> pathSteps,
        Double x,
        Double y,
        Double width,
        Double height,
        String coordinateSpace,
        Boolean visible,
        String htmlSnippet,
        IssueLocatorCarouselContext carouselContext
) {
    public IssueLocator {
        pathSteps = pathSteps == null ? List.of() : List.copyOf(pathSteps);
    }
}
