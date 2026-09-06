package com.accessibility.platform.dashboard.service;

import com.accessibility.platform.analysis.domain.Severity;
import com.accessibility.platform.analysis.repository.IssueResultRepository;
import com.accessibility.platform.dashboard.dto.DashboardIssueGroupResponse;
import com.accessibility.platform.dashboard.dto.DashboardLatestIssueCountsResponse;
import com.accessibility.platform.dashboard.dto.DashboardOrganizationResponse;
import com.accessibility.platform.dashboard.dto.DashboardOverviewResponse;
import com.accessibility.platform.dashboard.dto.DashboardScoreResponse;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.dto.EvaluationRequestResponse;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.result.dto.EvaluationResultSummaryResponse;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetStatus;
import com.accessibility.platform.target.dto.EvaluationTargetResponse;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class DashboardQueryService {

    private static final Comparator<EvaluationRequest> REQUEST_RECENCY = Comparator
            .comparing(EvaluationRequest::getUpdatedAt, Comparator.nullsFirst(LocalDateTime::compareTo))
            .thenComparing(EvaluationRequest::getId, Comparator.nullsFirst(Long::compareTo));

    private final OrganizationRepository organizationRepository;
    private final EvaluationTargetRepository evaluationTargetRepository;
    private final EvaluationRequestRepository evaluationRequestRepository;
    private final ScoreResultRepository scoreResultRepository;
    private final IssueResultRepository issueResultRepository;

    public DashboardOverviewResponse getOverview() {
        List<Organization> organizations = organizationRepository.findByStatus(OrganizationStatus.ACTIVE).stream()
                .sorted(Comparator.comparing(Organization::getId))
                .toList();
        List<EvaluationTarget> targets = evaluationTargetRepository.findDashboardTargets(
                OrganizationStatus.ACTIVE,
                TargetStatus.ACTIVE
        );
        List<EvaluationRequest> requests = evaluationRequestRepository.findDashboardRequests(
                OrganizationStatus.ACTIVE,
                TargetStatus.ACTIVE
        );
        List<DashboardScoreResponse> scores = scoreResultRepository.findDashboardScores(
                        OrganizationStatus.ACTIVE,
                        TargetStatus.ACTIVE,
                        EvaluationRequestStatus.COMPLETED
                ).stream()
                .map(DashboardScoreResponse::from)
                .toList();
        Map<Long, EnumMap<Severity, Long>> severityCountsByRequestId = buildSeverityCounts(
                issueResultRepository.findDashboardSeverityCounts(
                        OrganizationStatus.ACTIVE,
                        TargetStatus.ACTIVE,
                        EvaluationRequestStatus.COMPLETED
                )
        );

        Map<Long, EvaluationRequest> latestCompletedRequestByTargetId = findLatestCompletedRequests(requests);
        List<Long> latestCompletedRequestIds = latestCompletedRequestByTargetId.values().stream()
                .map(EvaluationRequest::getId)
                .sorted()
                .toList();
        Map<Long, List<DashboardIssueGroupResponse>> groupsByRequestId = latestCompletedRequestIds.isEmpty()
                ? Map.of()
                : buildIssueGroups(issueResultRepository.findDashboardIssueGroups(latestCompletedRequestIds));

        Map<Long, List<EvaluationTargetResponse>> targetResponsesByOrganizationId = new HashMap<>();
        for (EvaluationTarget target : targets) {
            targetResponsesByOrganizationId
                    .computeIfAbsent(target.getOrganization().getId(), ignored -> new ArrayList<>())
                    .add(EvaluationTargetResponse.from(target));
        }
        List<DashboardOrganizationResponse> organizationResponses = organizations.stream()
                .map(organization -> DashboardOrganizationResponse.from(
                        organization,
                        targetResponsesByOrganizationId.getOrDefault(organization.getId(), List.of())
                ))
                .toList();

        Map<Long, DashboardScoreResponse> scoreByRequestId = new HashMap<>();
        for (DashboardScoreResponse score : scores) {
            scoreByRequestId.put(score.evaluationRequestId(), score);
        }
        List<EvaluationResultSummaryResponse> summaries = requests.stream()
                .filter(request -> request.getStatus() == EvaluationRequestStatus.COMPLETED)
                .map(request -> buildSummary(
                        request,
                        scoreByRequestId.get(request.getId()),
                        severityCountsByRequestId.get(request.getId())
                ))
                .toList();
        List<DashboardLatestIssueCountsResponse> latestIssueCounts = latestCompletedRequestByTargetId.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(entry -> buildLatestIssueCounts(
                        entry.getKey(),
                        entry.getValue().getId(),
                        groupsByRequestId.getOrDefault(entry.getValue().getId(), List.of())
                ))
                .toList();

        return new DashboardOverviewResponse(
                organizationResponses,
                requests.stream().map(EvaluationRequestResponse::from).toList(),
                summaries,
                scores,
                latestIssueCounts
        );
    }

    private Map<Long, EnumMap<Severity, Long>> buildSeverityCounts(
            List<IssueResultRepository.RequestSeverityCountProjection> projections
    ) {
        Map<Long, EnumMap<Severity, Long>> countsByRequestId = new HashMap<>();
        for (IssueResultRepository.RequestSeverityCountProjection projection : projections) {
            countsByRequestId
                    .computeIfAbsent(projection.getRequestId(), ignored -> new EnumMap<>(Severity.class))
                    .put(projection.getSeverity(), projection.getIssueCount());
        }
        return countsByRequestId;
    }

    private Map<Long, List<DashboardIssueGroupResponse>> buildIssueGroups(
            List<IssueResultRepository.RequestIssueGroupProjection> projections
    ) {
        Map<Long, List<DashboardIssueGroupResponse>> groupsByRequestId = new HashMap<>();
        for (IssueResultRepository.RequestIssueGroupProjection projection : projections) {
            groupsByRequestId
                    .computeIfAbsent(projection.getRequestId(), ignored -> new ArrayList<>())
                    .add(new DashboardIssueGroupResponse(
                            projection.getIssueCode(),
                            projection.getIssueTitle(),
                            projection.getSeverity(),
                            projection.getIssueCount()
                    ));
        }
        return groupsByRequestId;
    }

    private Map<Long, EvaluationRequest> findLatestCompletedRequests(List<EvaluationRequest> requests) {
        Map<Long, EvaluationRequest> latestByTargetId = new HashMap<>();
        for (EvaluationRequest request : requests) {
            if (request.getStatus() != EvaluationRequestStatus.COMPLETED) {
                continue;
            }
            latestByTargetId.merge(
                    request.getEvaluationTarget().getId(),
                    request,
                    (current, candidate) -> REQUEST_RECENCY.compare(candidate, current) > 0 ? candidate : current
            );
        }
        return latestByTargetId;
    }

    private EvaluationResultSummaryResponse buildSummary(
            EvaluationRequest request,
            DashboardScoreResponse score,
            EnumMap<Severity, Long> severityCounts
    ) {
        long totalIssueCount = severityCounts == null
                ? 0
                : severityCounts.values().stream().mapToLong(Long::longValue).sum();
        long criticalIssueCount = count(severityCounts, Severity.CRITICAL);
        return new EvaluationResultSummaryResponse(
                request.getId(),
                request.getEvaluationTarget().getName(),
                request.getStatus(),
                score == null ? BigDecimal.ZERO : score.totalScore(),
                totalIssueCount,
                criticalIssueCount,
                request.getRequestedAt()
        );
    }

    private DashboardLatestIssueCountsResponse buildLatestIssueCounts(
            Long targetId,
            Long requestId,
            List<DashboardIssueGroupResponse> groups
    ) {
        EnumMap<Severity, Long> counts = new EnumMap<>(Severity.class);
        for (DashboardIssueGroupResponse group : groups) {
            counts.merge(group.severity(), group.count(), Long::sum);
        }
        long totalIssueCount = counts.values().stream().mapToLong(Long::longValue).sum();
        return new DashboardLatestIssueCountsResponse(
                targetId,
                requestId,
                totalIssueCount,
                count(counts, Severity.CRITICAL),
                count(counts, Severity.HIGH),
                count(counts, Severity.MEDIUM),
                count(counts, Severity.LOW),
                groups
        );
    }

    private long count(EnumMap<Severity, Long> counts, Severity severity) {
        return counts == null ? 0 : counts.getOrDefault(severity, 0L);
    }
}
