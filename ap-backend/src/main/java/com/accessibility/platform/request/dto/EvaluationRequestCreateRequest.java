package com.accessibility.platform.request.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record EvaluationRequestCreateRequest(
    @NotNull Long evaluationTargetId,
    @Size(max = 500) String requestNote
) {
}
