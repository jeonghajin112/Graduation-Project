package com.accessibility.platform.capturemetadata.dto;

import com.accessibility.platform.capturemetadata.domain.EvaluationCaptureMetadata;

import java.time.LocalDateTime;

public record EvaluationCaptureMetadataResponse(
        Long id,
        Long requestId,
        String requestedUrl,
        String finalUrl,
        LocalDateTime capturedAt,
        int viewportWidthCssPx,
        int viewportHeightCssPx,
        double deviceScaleFactor,
        int pageWidthCssPx,
        int pageHeightCssPx
) {
    public static EvaluationCaptureMetadataResponse from(EvaluationCaptureMetadata metadata) {
        return new EvaluationCaptureMetadataResponse(
                metadata.getId(),
                metadata.getEvaluationRequest().getId(),
                metadata.getRequestedUrl(),
                metadata.getFinalUrl(),
                metadata.getCapturedAt(),
                metadata.getViewportWidthCssPx(),
                metadata.getViewportHeightCssPx(),
                metadata.getDeviceScaleFactor(),
                metadata.getPageWidthCssPx(),
                metadata.getPageHeightCssPx()
        );
    }
}
