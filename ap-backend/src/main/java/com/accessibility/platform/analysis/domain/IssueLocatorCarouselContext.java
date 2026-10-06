package com.accessibility.platform.analysis.domain;

public record IssueLocatorCarouselContext(
        int carouselId,
        int slideIndex,
        int slideCount
) {
    public static final int MAX_SLIDE_COUNT = 10_000;

    public IssueLocatorCarouselContext {
        if (!isValid(carouselId, slideIndex, slideCount)) {
            throw new IllegalArgumentException("Invalid issue locator carousel context");
        }
    }

    public static boolean isValid(int carouselId, int slideIndex, int slideCount) {
        return carouselId > 0
                && slideIndex >= 0
                && slideCount >= 2
                && slideCount <= MAX_SLIDE_COUNT
                && slideIndex < slideCount;
    }
}
