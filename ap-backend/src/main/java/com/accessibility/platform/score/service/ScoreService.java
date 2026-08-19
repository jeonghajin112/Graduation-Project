package com.accessibility.platform.score.service;

import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.service.EvaluationRequestService;
import com.accessibility.platform.score.domain.ScoreDetail;
import com.accessibility.platform.score.domain.ScoreResult;
import com.accessibility.platform.score.dto.ScoreDetailResponse;
import com.accessibility.platform.score.dto.ScoreResultCreateRequest;
import com.accessibility.platform.score.dto.ScoreResultResponse;
import com.accessibility.platform.score.repository.ScoreDetailRepository;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class ScoreService {

    private final ScoreResultRepository scoreResultRepository;
    private final ScoreDetailRepository scoreDetailRepository;
    private final EvaluationRequestService evaluationRequestService;

    @Transactional
    public ScoreResultResponse createScoreResult(ScoreResultCreateRequest request) {
        EvaluationRequest evaluationRequest = evaluationRequestService.getRequest(request.evaluationRequestId());
        
        ScoreResult scoreResult = new ScoreResult(
                evaluationRequest,
                request.totalScore(),
                request.ruleScore(),
                request.aiScore(),
                request.cvScore()
        );
        ScoreResult savedResult = scoreResultRepository.save(scoreResult);

        List<ScoreDetail> details = request.details().stream()
                .map(d -> new ScoreDetail(
                        savedResult,
                        d.category(),
                        d.score(),
                        d.maxScore(),
                        d.comment()
                ))
                .toList();
        scoreDetailRepository.saveAll(details);

        List<ScoreDetailResponse> detailResponses = details.stream()
                .map(ScoreDetailResponse::from)
                .toList();

        return ScoreResultResponse.from(savedResult, detailResponses);
    }

    public ScoreResultResponse findByRequestId(Long requestId) {
        ScoreResult scoreResult = scoreResultRepository.findByEvaluationRequestId(requestId)
                .orElseThrow(ResourceNotFoundException::new);
        
        List<ScoreDetailResponse> details = scoreDetailRepository.findByScoreResultId(scoreResult.getId()).stream()
                .map(ScoreDetailResponse::from)
                .toList();

        return ScoreResultResponse.from(scoreResult, details);
    }
}
