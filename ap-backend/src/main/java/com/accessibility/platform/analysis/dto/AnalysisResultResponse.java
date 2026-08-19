package com.accessibility.platform.analysis.dto;

import com.accessibility.platform.analysis.domain.AnalysisResult;
import com.accessibility.platform.analysis.domain.AnalysisStatus;
import com.accessibility.platform.analysis.domain.AnalyzerType;

import java.time.LocalDateTime;

public record AnalysisResultResponse(
    Long id,
    Long evaluationRequestId,
    AnalyzerType analyzerType,
    AnalysisStatus status,
    String summary,
    LocalDateTime startedAt,
    LocalDateTime completedAt,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {
    public static AnalysisResultResponse from(AnalysisResult analysisResult) {
        return new AnalysisResultResponse(
            analysisResult.getId(),
            analysisResult.getEvaluationRequest().getId(),
            analysisResult.getAnalyzerType(),
            analysisResult.getStatus(),
            analysisResult.getSummary(),
            analysisResult.getStartedAt(),
            analysisResult.getCompletedAt(),
            analysisResult.getCreatedAt(),
            analysisResult.getUpdatedAt()
        );
    }
}
