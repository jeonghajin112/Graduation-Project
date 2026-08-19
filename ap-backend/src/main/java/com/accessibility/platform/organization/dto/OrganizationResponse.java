package com.accessibility.platform.organization.dto;

import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.organization.domain.OrganizationType;

import java.time.LocalDateTime;

public record OrganizationResponse(
    Long id,
    String name,
    OrganizationType type,
    String homepageUrl,
    String description,
    OrganizationStatus status,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {
    public static OrganizationResponse from(Organization organization) {
        return new OrganizationResponse(
            organization.getId(),
            organization.getName(),
            organization.getType(),
            organization.getHomepageUrl(),
            organization.getDescription(),
            organization.getStatus(),
            organization.getCreatedAt(),
            organization.getUpdatedAt()
        );
    }
}
