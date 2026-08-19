package com.accessibility.platform.score.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;

public record ScoreDetailRequest(
    @NotBlank String category,
    @NotNull BigDecimal score,
    @NotNull BigDecimal maxScore,
    String comment
) {
}
