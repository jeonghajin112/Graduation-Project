package com.accessibility.platform.analysis.dto;

import com.accessibility.platform.analysis.domain.Severity;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record IssueResultCreateRequest(
    @NotNull Long analysisResultId,
    @NotBlank @Size(max = 100) String issueCode,
    @NotBlank @Size(max = 200) String issueTitle,
    @NotNull Severity severity,
    @Size(max = 500) String locationPath,
    String message
) {
}
