package com.accessibility.platform.target.service;

import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.dto.EvaluationTargetCreateRequest;
import com.accessibility.platform.target.dto.EvaluationTargetResponse;
import com.accessibility.platform.target.dto.EvaluationTargetUpdateRequest;
import com.accessibility.platform.target.domain.TargetStatus;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Objects;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class EvaluationTargetService {

    private final EvaluationTargetRepository evaluationTargetRepository;
    private final OrganizationRepository organizationRepository;
    private final FaviconService faviconService;

    @Transactional
    public EvaluationTargetResponse create(EvaluationTargetCreateRequest request) {
        Organization organization = organizationRepository.findById(request.organizationId())
                .orElseThrow(ResourceNotFoundException::new);

        EvaluationTarget target = new EvaluationTarget(
                organization,
                request.name(),
                request.targetType(),
                request.accessUrl(),
                request.description(),
                faviconService.findFaviconUrl(request.accessUrl()).orElse(null)
        );
        return EvaluationTargetResponse.from(evaluationTargetRepository.save(target));
    }

    public List<EvaluationTargetResponse> findAll() {
        return evaluationTargetRepository.findAll().stream()
                .map(EvaluationTargetResponse::from)
                .toList();
    }

    public List<EvaluationTargetResponse> findByOrganizationId(Long organizationId) {
        return evaluationTargetRepository.findByOrganizationIdAndStatusNot(organizationId, TargetStatus.DELETED).stream()
                .map(EvaluationTargetResponse::from)
                .toList();
    }

    public EvaluationTargetResponse findById(Long id) {
        return EvaluationTargetResponse.from(getTarget(id));
    }

    @Transactional
    public EvaluationTargetResponse update(Long id, EvaluationTargetUpdateRequest request) {
        EvaluationTarget target = getTarget(id);
        String faviconUrl = Objects.equals(target.getAccessUrl(), request.accessUrl())
                ? target.getFaviconUrl()
                : faviconService.findFaviconUrl(request.accessUrl()).orElse(null);
        target.update(
                request.name(),
                request.targetType(),
                request.accessUrl(),
                request.description(),
                faviconUrl
        );
        return EvaluationTargetResponse.from(target);
    }

    @Transactional
    public void deactivate(Long id) {
        getTarget(id).deactivate();
    }

    @Transactional
    public void deleteLogical(Long id) {
        getTarget(id).markDeleted();
    }

    public EvaluationTarget getTarget(Long id) {
        return evaluationTargetRepository.findById(id)
                .orElseThrow(ResourceNotFoundException::new);
    }
}
