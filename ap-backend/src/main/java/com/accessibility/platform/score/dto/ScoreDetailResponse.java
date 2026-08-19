package com.accessibility.platform.score.dto;

import com.accessibility.platform.score.domain.ScoreDetail;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public record ScoreDetailResponse(
    Long id,
    String category,
    BigDecimal score,
    BigDecimal maxScore,
    String comment,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {
    public static ScoreDetailResponse from(ScoreDetail scoreDetail) {
        return new ScoreDetailResponse(
            scoreDetail.getId(),
            scoreDetail.getCategory(),
            scoreDetail.getScore(),
            scoreDetail.getMaxScore(),
            scoreDetail.getComment(),
            scoreDetail.getCreatedAt(),
            scoreDetail.getUpdatedAt()
        );
    }
}
