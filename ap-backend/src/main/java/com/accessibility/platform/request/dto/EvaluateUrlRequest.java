package com.accessibility.platform.request.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record EvaluateUrlRequest(
    @NotBlank
    @Size(max = 500)
    String url
) {
}
