package com.accessibility.platform.target.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record EvaluationTargetLightRequest(
    @NotBlank @Size(max = 100) String name,
    @NotBlank @Size(max = 500) String accessUrl
) {
}
