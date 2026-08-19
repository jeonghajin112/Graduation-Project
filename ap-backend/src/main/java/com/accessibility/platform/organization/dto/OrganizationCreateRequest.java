package com.accessibility.platform.organization.dto;

import com.accessibility.platform.organization.domain.OrganizationType;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record OrganizationCreateRequest(
    @NotBlank @Size(max = 100) String name,
    @NotNull OrganizationType type,
    @Size(max = 255) String homepageUrl,
    @Size(max = 500) String description
) {
}
