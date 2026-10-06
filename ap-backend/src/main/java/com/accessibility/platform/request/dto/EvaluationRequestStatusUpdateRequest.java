package com.accessibility.platform.request.dto;

import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import jakarta.validation.constraints.NotNull;

public record EvaluationRequestStatusUpdateRequest(
    @NotNull EvaluationRequestStatus status
) {
}
