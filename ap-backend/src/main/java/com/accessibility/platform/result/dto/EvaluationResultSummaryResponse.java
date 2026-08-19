package com.accessibility.platform.result.dto;

import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import java.math.BigDecimal;
import java.time.LocalDateTime;

public record EvaluationResultSummaryResponse(
    Long requestId,
    String targetName,
    EvaluationRequestStatus status,
    BigDecimal totalScore,
    long totalIssueCount,
    long criticalIssueCount,
    LocalDateTime requestedAt
) {
}
