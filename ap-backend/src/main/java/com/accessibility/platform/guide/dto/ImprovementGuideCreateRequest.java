package com.accessibility.platform.guide.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record ImprovementGuideCreateRequest(
    @NotNull Long issueResultId,
    @NotBlank @Size(max = 500) String guideTitle,
    @NotBlank String content,
    @Size(max = 500) String referenceUrl
) {
}
