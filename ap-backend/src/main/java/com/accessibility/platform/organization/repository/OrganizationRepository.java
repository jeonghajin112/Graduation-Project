package com.accessibility.platform.organization.repository;

import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface OrganizationRepository extends JpaRepository<Organization, Long> {
    Optional<Organization> findByName(String name);
    Optional<Organization> findByCreationIdempotencyKey(String creationIdempotencyKey);
    List<Organization> findByStatus(OrganizationStatus status);
}
