package com.accessibility.platform.organization.service;

import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.organization.dto.OrganizationCreateRequest;
import com.accessibility.platform.organization.dto.OrganizationResponse;
import com.accessibility.platform.organization.dto.OrganizationUpdateRequest;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class OrganizationService {

    private final OrganizationRepository organizationRepository;

    @Transactional
    public OrganizationResponse create(OrganizationCreateRequest request) {
        Organization organization = new Organization(
            request.name(),
            request.type(),
            request.homepageUrl(),
            request.description()
        );
        return OrganizationResponse.from(organizationRepository.save(organization));
    }

    public List<OrganizationResponse> findAll() {
        return organizationRepository.findByStatus(OrganizationStatus.ACTIVE).stream()
            .map(OrganizationResponse::from)
            .toList();
    }

    public OrganizationResponse findById(Long id) {
        return OrganizationResponse.from(getOrganization(id));
    }

    @Transactional
    public OrganizationResponse update(Long id, OrganizationUpdateRequest request) {
        Organization organization = getOrganization(id);
        organization.update(
            request.name(),
            request.type(),
            request.homepageUrl(),
            request.description()
        );
        return OrganizationResponse.from(organization);
    }

    @Transactional
    public void deactivate(Long id) {
        getOrganization(id).deactivate();
    }

    public Organization getOrganization(Long id) {
        return organizationRepository.findById(id)
            .orElseThrow(ResourceNotFoundException::new);
    }
}
