package com.accessibility.platform.target.dto;

import com.accessibility.platform.target.domain.TargetType;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record EvaluationTargetUpdateRequest(
    @NotBlank @Size(max = 100) String name,
    @NotNull TargetType targetType,
    @NotBlank @Size(max = 500) String accessUrl,
    @Size(max = 1000) String description
) {
}
