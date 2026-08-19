package com.accessibility.platform.artifact.dto;

import com.accessibility.platform.artifact.domain.CaptureMode;
import jakarta.validation.constraints.*;

import java.time.LocalDateTime;

public record EvaluationArtifactMetadataRequest(
        @NotBlank @Size(max = 2048) String requestedUrl,
        @NotBlank @Size(max = 2048) String finalUrl,
        @NotNull LocalDateTime capturedAt,
        @Positive int viewportWidthCssPx,
        @Positive int viewportHeightCssPx,
        @DecimalMin(value = "0.1") @DecimalMax(value = "10.0") double deviceScaleFactor,
        @Positive int pageWidthCssPx,
        @Positive int pageHeightCssPx,
        @NotNull CaptureMode captureMode
) {
}
