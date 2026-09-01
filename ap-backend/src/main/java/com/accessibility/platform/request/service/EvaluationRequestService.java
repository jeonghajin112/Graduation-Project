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
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
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
    private final OrganizationRepository organizationRepository;
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
                .findFirst();

        EvaluationTarget target;
        if (existingTarget.isPresent()) {
            target = existingTarget.get();
            enrichFaviconIfMissing(target);
        } else {
            Organization organization = organizationRepository.findByName("AI Module Imported")
                    .orElseGet(() -> organizationRepository.save(new Organization(
                            "AI Module Imported",
                            OrganizationType.ETC,
                            null,
                            "AI-module imported evaluation results"
                    )));

            target = evaluationTargetRepository.save(new EvaluationTarget(
                    organization,
                    targetName(url),
                    TargetType.WEB,
                    url,
                    "Created automatically from Web UI URL input",
                    faviconService.findFaviconUrl(url).orElse(null)
            ));
        }

        EvaluationRequest evaluationRequest = new EvaluationRequest(target, "Web UI initiated request");
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
