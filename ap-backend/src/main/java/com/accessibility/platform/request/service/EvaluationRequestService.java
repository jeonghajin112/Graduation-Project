package com.accessibility.platform.request.service;

import com.accessibility.platform.common.exception.BusinessException;
import com.accessibility.platform.common.exception.ErrorCode;
import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.dto.EvaluationRequestCreateRequest;
import com.accessibility.platform.request.dto.EvaluationRequestResponse;
import com.accessibility.platform.request.dto.EvaluationRequestStatusUpdateRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.service.EvaluationTargetService;
import com.accessibility.platform.request.dto.EvaluateUrlRequest;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.service.ImportedOrganizationService;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.domain.TargetStatus;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import com.accessibility.platform.target.service.FaviconService;
import com.accessibility.platform.integration.service.AiEvaluationRunnerService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class EvaluationRequestService {

    private final EvaluationRequestRepository evaluationRequestRepository;
    private final EvaluationTargetService evaluationTargetService;
    private final EvaluationTargetRepository evaluationTargetRepository;
    private final ImportedOrganizationService importedOrganizationService;
    private final AiEvaluationRunnerService aiEvaluationRunnerService;
    private final FaviconService faviconService;

    @Transactional
    public EvaluationRequestResponse create(EvaluationRequestCreateRequest request) {
        EvaluationTarget target = evaluationTargetService.getTarget(request.evaluationTargetId());
        EvaluationRequest evaluationRequest = new EvaluationRequest(target, request.requestNote());
        EvaluationRequest savedRequest = evaluationRequestRepository.save(evaluationRequest);

        // Run the Python analysis asynchronously in the background
        aiEvaluationRunnerService.runEvaluationAsync(savedRequest.getId(), target.getAccessUrl());

        return EvaluationRequestResponse.from(savedRequest);
    }

    @Transactional
    public EvaluationRequestResponse createForUrl(EvaluateUrlRequest request) {
        String url = request.url();
        Optional<EvaluationTarget> existingTarget = evaluationTargetRepository.findAllByAccessUrlOrderByIdDesc(url).stream()
                .filter(candidate -> candidate.getStatus() != TargetStatus.DELETED)
                .filter(candidate -> candidate.getOrganization().getStatus() == OrganizationStatus.ACTIVE)
                .findFirst();

        EvaluationTarget target;
        if (existingTarget.isPresent()) {
            target = existingTarget.get();
            enrichFaviconIfMissing(target);
        } else {
            Organization organization = importedOrganizationService.getOrCreate();

            target = evaluationTargetRepository.save(new EvaluationTarget(
                    organization,
                    targetName(url),
                    TargetType.WEB,
                    url,
                    "Created automatically from Web UI URL input",
                    faviconService.findFaviconUrl(url).orElse(null)
            ));
        }

        EvaluationRequest evaluationRequest = new EvaluationRequest(target, EvaluationRequest.QUICK_ANALYSIS_NOTE);
        EvaluationRequest savedRequest = evaluationRequestRepository.save(evaluationRequest);

        // Run the Python analysis asynchronously in the background
        aiEvaluationRunnerService.runEvaluationAsync(savedRequest.getId(), target.getAccessUrl());

        return EvaluationRequestResponse.from(savedRequest);
    }

    private void enrichFaviconIfMissing(EvaluationTarget target) {
        if (target.getFaviconUrl() == null || target.getFaviconUrl().isBlank()) {
            faviconService.findFaviconUrl(target.getAccessUrl()).ifPresent(target::updateFaviconUrl);
        }
    }

    private String targetName(String url) {
        if (url == null || url.isBlank()) {
            return "Web UI Evaluation Target";
        }
        try {
            String host = java.net.URI.create(url).getHost();
            return host == null || host.isBlank() ? url : host;
        } catch (IllegalArgumentException e) {
            return url;
        }
    }

    public List<EvaluationRequestResponse> findAll() {
        return evaluationRequestRepository.findAll().stream()
                .map(EvaluationRequestResponse::from)
                .toList();
    }

    public EvaluationRequestResponse findById(Long id) {
        return EvaluationRequestResponse.from(getRequest(id));
    }

    public List<EvaluationRequestResponse> findActiveForTarget(Long targetId) {
        evaluationTargetService.getTarget(targetId);
        return evaluationRequestRepository.findByEvaluationTargetIdAndStatusIn(targetId,
                List.of(com.accessibility.platform.request.domain.EvaluationRequestStatus.PENDING,
                        com.accessibility.platform.request.domain.EvaluationRequestStatus.IN_PROGRESS))
                .stream().map(EvaluationRequestResponse::from).toList();
    }

    public List<com.accessibility.platform.request.dto.EvaluationRequestStatusEntry> findStatuses(List<Long> ids) {
        if (ids.isEmpty() || ids.size() > 100 || ids.stream().anyMatch(id -> id == null || id <= 0)
                || ids.stream().distinct().count() != ids.size()) throw new BusinessException(ErrorCode.INVALID_REQUEST);
        var found = evaluationRequestRepository.findStatusRequests(ids).stream().collect(java.util.stream.Collectors.toMap(EvaluationRequest::getId, value -> value));
        return ids.stream().map(id -> {
            var request = found.get(id);
            if (request == null) return new com.accessibility.platform.request.dto.EvaluationRequestStatusEntry(id, "NOT_FOUND", null);
            var target = request.getEvaluationTarget();
            if (target.getStatus() != TargetStatus.ACTIVE || target.getOrganization().getStatus() != OrganizationStatus.ACTIVE)
                return new com.accessibility.platform.request.dto.EvaluationRequestStatusEntry(id, "REMOVED", null);
            return new com.accessibility.platform.request.dto.EvaluationRequestStatusEntry(id, "FOUND", EvaluationRequestResponse.from(request));
        }).toList();
    }

    @Transactional
    public EvaluationRequestResponse updateStatus(Long id, EvaluationRequestStatusUpdateRequest request) {
        EvaluationRequest evaluationRequest = evaluationRequestRepository.findByIdForUpdate(id)
                .orElseThrow(ResourceNotFoundException::new);
        if (!evaluationRequest.getStatus().canTransitionTo(request.status())) {
            throw new BusinessException(ErrorCode.INVALID_STATUS_TRANSITION);
        }
        evaluationRequest.changeStatus(request.status());
        return EvaluationRequestResponse.from(evaluationRequest);
    }

    public EvaluationRequest getRequest(Long id) {
        return evaluationRequestRepository.findById(id)
                .orElseThrow(ResourceNotFoundException::new);
    }
}
