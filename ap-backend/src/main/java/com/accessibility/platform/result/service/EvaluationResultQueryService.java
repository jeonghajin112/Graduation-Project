package com.accessibility.platform.result.service;

import com.accessibility.platform.analysis.domain.AnalyzerType;
import com.accessibility.platform.analysis.domain.Severity;
import com.accessibility.platform.analysis.repository.IssueResultRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.result.dto.EvaluationIssueResponse;
import com.accessibility.platform.result.dto.IssueLocatorResponse;
import com.accessibility.platform.request.service.EvaluationRequestService;
import com.accessibility.platform.result.dto.EvaluationResultSummaryResponse;
import com.accessibility.platform.score.domain.ScoreResult;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class EvaluationResultQueryService {

    private final EvaluationRequestService evaluationRequestService;
    private final ScoreResultRepository scoreResultRepository;
    private final IssueResultRepository issueResultRepository;

    public EvaluationResultSummaryResponse getSummary(Long requestId) {
        EvaluationRequest request = evaluationRequestService.getRequest(requestId);
        
        BigDecimal totalScore = scoreResultRepository.findByEvaluationRequestId(requestId)
                .map(ScoreResult::getTotalScore)
                .orElse(BigDecimal.ZERO);

        IssueResultRepository.RequestIssueSummaryProjection issueSummary =
                issueResultRepository.summarizeRequestIssues(requestId, Severity.CRITICAL);

        return new EvaluationResultSummaryResponse(
                request.getId(),
                request.getEvaluationTarget().getName(),
                request.getStatus(),
                totalScore,
                issueSummary.getTotalIssueCount(),
                issueSummary.getCriticalIssueCount(),
                request.getRequestedAt()
        );
    }

    public List<EvaluationIssueResponse> getIssues(Long requestId) {
        evaluationRequestService.getRequest(requestId);

        return issueResultRepository.findIssueDetailsByRequestId(requestId).stream()
                .map(issue -> new EvaluationIssueResponse(
                        issue.getId(),
                        requestId,
                        moduleName(issue.getAnalysisResult().getAnalyzerType()),
                        issueSeverity(issue.getSeverity()),
                        issue.getIssueTitle(),
                        issue.getMessage(),
                        recommendation(issue.getMessage()),
                        issue.getLocationPath(),
                        issue.getIssueCode(),
                        IssueLocatorResponse.from(issue.getLocator()),
                        issue.getCreatedAt()
                ))
                .toList();
    }

    private String moduleName(AnalyzerType analyzerType) {
        return switch (analyzerType) {
            case RULE_BASED -> "rule_based";
            case AI_TEXT -> "text_difficulty";
            case CV_VISION -> "cv_visual";
        };
    }

    private String issueSeverity(Severity severity) {
        return switch (severity) {
            case CRITICAL -> "CRITICAL";
            case HIGH -> "SERIOUS";
            case MEDIUM -> "MODERATE";
            case LOW -> "MINOR";
        };
    }

    private String recommendation(String message) {
        if (message == null || message.isBlank()) {
            return null;
        }

        String marker = "suggestions=";
        int markerIndex = message.indexOf(marker);
        if (markerIndex < 0) {
            return null;
        }

        String value = message.substring(markerIndex + marker.length()).trim();
        return value.isBlank() ? null : value;
    }
}
