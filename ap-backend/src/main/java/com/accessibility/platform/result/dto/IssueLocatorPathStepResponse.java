package com.accessibility.platform.result.dto;

import com.accessibility.platform.analysis.domain.IssueLocatorPathStep;

public record IssueLocatorPathStepResponse(
        String context,
        String selector,
        String frameUrl
) {
    public static IssueLocatorPathStepResponse from(IssueLocatorPathStep pathStep) {
        return new IssueLocatorPathStepResponse(
                pathStep.context(),
                pathStep.selector(),
                pathStep.frameUrl()
        );
    }
}
