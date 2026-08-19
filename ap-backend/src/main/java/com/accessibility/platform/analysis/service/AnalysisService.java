package com.accessibility.platform.analysis.service;

import com.accessibility.platform.analysis.domain.AnalysisResult;
import com.accessibility.platform.analysis.domain.IssueResult;
import com.accessibility.platform.analysis.dto.AnalysisResultCreateRequest;
import com.accessibility.platform.analysis.dto.AnalysisResultResponse;
import com.accessibility.platform.analysis.dto.IssueResultCreateRequest;
import com.accessibility.platform.analysis.dto.IssueResultResponse;
import com.accessibility.platform.analysis.repository.AnalysisResultRepository;
import com.accessibility.platform.analysis.repository.IssueResultRepository;
import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.service.EvaluationRequestService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class AnalysisService {

    private final AnalysisResultRepository analysisResultRepository;
    private final IssueResultRepository issueResultRepository;
    private final EvaluationRequestService evaluationRequestService;

    @Transactional
    public AnalysisResultResponse createAnalysisResult(AnalysisResultCreateRequest request) {
        EvaluationRequest evaluationRequest = evaluationRequestService.getRequest(request.evaluationRequestId());
        AnalysisResult analysisResult = new AnalysisResult(
                evaluationRequest,
                request.analyzerType(),
                request.status(),
                request.summary(),
                request.startedAt(),
                request.completedAt()
        );
        return AnalysisResultResponse.from(analysisResultRepository.save(analysisResult));
    }

    @Transactional
    public IssueResultResponse createIssueResult(IssueResultCreateRequest request) {
        AnalysisResult analysisResult = analysisResultRepository.findById(request.analysisResultId())
                .orElseThrow(ResourceNotFoundException::new);
        IssueResult issueResult = new IssueResult(
                analysisResult,
                request.issueCode(),
                request.issueTitle(),
                request.severity(),
                request.locationPath(),
                request.message()
        );
        return IssueResultResponse.from(issueResultRepository.save(issueResult));
    }

    public List<AnalysisResultResponse> findAnalysisResultsByRequestId(Long evaluationRequestId) {
        return analysisResultRepository.findByEvaluationRequestId(evaluationRequestId).stream()
                .map(AnalysisResultResponse::from)
                .toList();
    }

    public List<IssueResultResponse> findIssueResultsByAnalysisId(Long analysisResultId) {
        return issueResultRepository.findByAnalysisResultId(analysisResultId).stream()
                .map(IssueResultResponse::from)
                .toList();
    }
}
