package com.accessibility.platform.dashboard.dto;

import com.accessibility.platform.score.domain.ScoreResult;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public record DashboardScoreResponse(
        Long id,
        Long evaluationRequestId,
        BigDecimal totalScore,
        BigDecimal ruleScore,
        BigDecimal aiScore,
        BigDecimal cvScore,
        LocalDateTime createdAt,
        LocalDateTime updatedAt
) {
    public static DashboardScoreResponse from(ScoreResult scoreResult) {
        return new DashboardScoreResponse(
                scoreResult.getId(),
                scoreResult.getEvaluationRequest().getId(),
                scoreResult.getTotalScore(),
                scoreResult.getRuleScore(),
                scoreResult.getAiScore(),
                scoreResult.getCvScore(),
                scoreResult.getCreatedAt(),
                scoreResult.getUpdatedAt()
        );
    }
}
