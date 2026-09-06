package com.accessibility.platform.capturemetadata.dto;

import java.time.LocalDateTime;

public record EvaluationCaptureMetadataInput(
        String requestedUrl,
        String finalUrl,
        LocalDateTime capturedAt,
        int viewportWidthCssPx,
        int viewportHeightCssPx,
        double deviceScaleFactor,
        int pageWidthCssPx,
        int pageHeightCssPx
) {
}
