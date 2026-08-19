package com.accessibility.platform.guide.dto;

import com.accessibility.platform.guide.domain.ImprovementGuide;

import java.time.LocalDateTime;

public record ImprovementGuideResponse(
    Long id,
    Long issueResultId,
    String guideTitle,
    String content,
    String referenceUrl,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {
    public static ImprovementGuideResponse from(ImprovementGuide guide) {
        return new ImprovementGuideResponse(
            guide.getId(),
            guide.getIssueResult().getId(),
            guide.getGuideTitle(),
            guide.getContent(),
            guide.getReferenceUrl(),
            guide.getCreatedAt(),
            guide.getUpdatedAt()
        );
    }
}
