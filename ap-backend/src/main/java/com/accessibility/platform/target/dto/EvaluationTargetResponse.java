package com.accessibility.platform.target.dto;

import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetStatus;
import com.accessibility.platform.target.domain.TargetType;

import java.time.LocalDateTime;

public record EvaluationTargetResponse(
    Long id,
    Long organizationId,
    String organizationName,
    String name,
    TargetType targetType,
    String accessUrl,
    String faviconUrl,
    String description,
    TargetStatus status,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {
    public static EvaluationTargetResponse from(EvaluationTarget target) {
        return new EvaluationTargetResponse(
            target.getId(),
            target.getOrganization().getId(),
            target.getOrganization().getName(),
            target.getName(),
            target.getTargetType(),
            target.getAccessUrl(),
            target.getFaviconUrl(),
            target.getDescription(),
            target.getStatus(),
            target.getCreatedAt(),
            target.getUpdatedAt()
        );
    }
}
