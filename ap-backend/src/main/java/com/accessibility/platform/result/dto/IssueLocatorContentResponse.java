package com.accessibility.platform.result.dto;

import com.accessibility.platform.analysis.domain.IssueLocatorContent;

public record IssueLocatorContentResponse(
        String text,
        String image
) {
    public static IssueLocatorContentResponse from(IssueLocatorContent content) {
        if (content == null) {
            return null;
        }
        return new IssueLocatorContentResponse(content.text(), content.image());
    }
}
