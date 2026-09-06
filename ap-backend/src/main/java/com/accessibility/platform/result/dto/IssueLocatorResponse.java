package com.accessibility.platform.result.dto;

import com.accessibility.platform.analysis.domain.IssueLocator;

import java.util.List;

public record IssueLocatorResponse(
        String kind,
        List<IssueLocatorPathStepResponse> pathSteps,
        Double x,
        Double y,
        Double width,
        Double height,
        String coordinateSpace,
        Boolean visible,
        String htmlSnippet,
        IssueLocatorCarouselContextResponse carouselContext
) {
    public static IssueLocatorResponse from(IssueLocator locator) {
        if (locator == null) {
            return null;
        }
        return new IssueLocatorResponse(
                locator.kind(),
                locator.pathSteps().stream().map(IssueLocatorPathStepResponse::from).toList(),
                locator.x(),
                locator.y(),
                locator.width(),
                locator.height(),
                locator.coordinateSpace(),
                locator.visible(),
                locator.htmlSnippet(),
                IssueLocatorCarouselContextResponse.from(locator.carouselContext())
        );
    }
}
