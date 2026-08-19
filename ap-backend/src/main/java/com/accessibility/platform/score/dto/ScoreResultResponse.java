package com.accessibility.platform.score.dto;

import com.accessibility.platform.score.domain.ScoreResult;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

public record ScoreResultResponse(
    Long id,
    Long evaluationRequestId,
    BigDecimal totalScore,
    BigDecimal ruleScore,
    BigDecimal aiScore,
    BigDecimal cvScore,
    List<ScoreDetailResponse> details,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {
    public static ScoreResultResponse from(ScoreResult scoreResult, List<ScoreDetailResponse> details) {
        return new ScoreResultResponse(
            scoreResult.getId(),
            scoreResult.getEvaluationRequest().getId(),
            scoreResult.getTotalScore(),
            scoreResult.getRuleScore(),
            scoreResult.getAiScore(),
            scoreResult.getCvScore(),
            details,
            scoreResult.getCreatedAt(),
            scoreResult.getUpdatedAt()
        );
    }
}
