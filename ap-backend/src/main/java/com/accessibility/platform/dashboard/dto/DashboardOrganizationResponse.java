package com.accessibility.platform.dashboard.dto;

import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.target.dto.EvaluationTargetResponse;

import java.time.LocalDateTime;
import java.util.List;

public record DashboardOrganizationResponse(
        Long id,
        String name,
        OrganizationType type,
        String homepageUrl,
        String description,
        boolean systemManaged,
        OrganizationStatus status,
        LocalDateTime createdAt,
        LocalDateTime updatedAt,
        List<EvaluationTargetResponse> evaluationTargets
) {
    public DashboardOrganizationResponse {
        evaluationTargets = List.copyOf(evaluationTargets);
    }

    public static DashboardOrganizationResponse from(
            Organization organization,
            List<EvaluationTargetResponse> evaluationTargets
    ) {
        return new DashboardOrganizationResponse(
                organization.getId(),
                organization.getName(),
                organization.getType(),
                organization.getHomepageUrl(),
                organization.getDescription(),
                organization.isSystemManaged(),
                organization.getStatus(),
                organization.getCreatedAt(),
                organization.getUpdatedAt(),
                evaluationTargets
        );
    }
}
