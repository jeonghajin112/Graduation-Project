package com.accessibility.platform.score.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;
import java.util.List;

public record ScoreResultCreateRequest(
    @NotNull Long evaluationRequestId,
    @NotNull BigDecimal totalScore,
    @NotNull BigDecimal ruleScore,
    @NotNull BigDecimal aiScore,
    @NotNull BigDecimal cvScore,
    @Valid List<ScoreDetailRequest> details
) {
}
