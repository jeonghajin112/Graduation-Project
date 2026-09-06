package com.accessibility.platform.result.dto;

import com.accessibility.platform.analysis.domain.IssueLocatorCarouselContext;

public record IssueLocatorCarouselContextResponse(
        int carouselId,
        int slideIndex,
        int slideCount
) {
    public static IssueLocatorCarouselContextResponse from(IssueLocatorCarouselContext context) {
        if (context == null) {
            return null;
        }
        return new IssueLocatorCarouselContextResponse(
                context.carouselId(),
                context.slideIndex(),
                context.slideCount()
        );
    }
}
