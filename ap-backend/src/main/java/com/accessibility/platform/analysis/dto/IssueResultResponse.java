package com.accessibility.platform.analysis.dto;

import com.accessibility.platform.analysis.domain.IssueResult;
import com.accessibility.platform.analysis.domain.Severity;

import java.time.LocalDateTime;

public record IssueResultResponse(
    Long id,
    Long analysisResultId,
    String issueCode,
    String issueTitle,
    Severity severity,
    String locationPath,
    String message,
    boolean resolved,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {
    public static IssueResultResponse from(IssueResult issueResult) {
        return new IssueResultResponse(
            issueResult.getId(),
            issueResult.getAnalysisResult().getId(),
            issueResult.getIssueCode(),
            issueResult.getIssueTitle(),
            issueResult.getSeverity(),
            issueResult.getLocationPath(),
            issueResult.getMessage(),
            issueResult.isResolved(),
            issueResult.getCreatedAt(),
            issueResult.getUpdatedAt()
        );
    }
}
