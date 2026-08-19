package com.accessibility.platform.artifact.dto;

import com.accessibility.platform.artifact.domain.CaptureMode;
import com.accessibility.platform.artifact.domain.EvaluationArtifact;

import java.time.LocalDateTime;

public record EvaluationArtifactResponse(
        Long id,
        Long requestId,
        String requestedUrl,
        String finalUrl,
        LocalDateTime capturedAt,
        int viewportWidthCssPx,
        int viewportHeightCssPx,
        double deviceScaleFactor,
        int pageWidthCssPx,
        int pageHeightCssPx,
        CaptureMode captureMode,
        String contentUrl,
        String contentType,
        long sizeBytes,
        String sha256,
        LocalDateTime createdAt,
        LocalDateTime updatedAt
) {
    public static EvaluationArtifactResponse from(EvaluationArtifact artifact) {
        return new EvaluationArtifactResponse(
                artifact.getId(),
                artifact.getEvaluationRequest().getId(),
                artifact.getRequestedUrl(),
                artifact.getFinalUrl(),
                artifact.getCapturedAt(),
                artifact.getViewportWidthCssPx(),
                artifact.getViewportHeightCssPx(),
                artifact.getDeviceScaleFactor(),
                artifact.getPageWidthCssPx(),
                artifact.getPageHeightCssPx(),
                artifact.getCaptureMode(),
                "/results/artifacts/" + artifact.getId() + "/content",
                artifact.getContentType(),
                artifact.getSizeBytes(),
                artifact.getSha256(),
                artifact.getCreatedAt(),
                artifact.getUpdatedAt()
        );
    }
}
