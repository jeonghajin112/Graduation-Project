package com.accessibility.platform.result.dto;

import java.time.LocalDateTime;

public record EvaluationIssueResponse(
        Long id,
        Long requestId,
        String module,
        String severity,
        String title,
        String description,
        String recommendation,
        String selector,
        String wcagCode,
        IssueLocatorResponse locator,
        LocalDateTime createdAt
) {
}
