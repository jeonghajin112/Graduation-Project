package com.accessibility.platform.analysis.dto;

import com.accessibility.platform.analysis.domain.AnalysisStatus;
import com.accessibility.platform.analysis.domain.AnalyzerType;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.LocalDateTime;

public record AnalysisResultCreateRequest(
    @NotNull Long evaluationRequestId,
    @NotNull AnalyzerType analyzerType,
    @NotNull AnalysisStatus status,
    @Size(max = 1000) String summary,
    LocalDateTime startedAt,
    LocalDateTime completedAt
) {
}
