package com.accessibility.platform.organization.service;

import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class ImportedOrganizationService {
    private final OrganizationRepository organizationRepository;

    @Transactional
    public Organization getOrCreate() {
        return organizationRepository.findByStatus(OrganizationStatus.ACTIVE).stream()
                .filter(Organization::isSystemManaged)
                .findFirst()
                .orElseGet(() -> organizationRepository.save(Organization.importedResults()));
    }
}
