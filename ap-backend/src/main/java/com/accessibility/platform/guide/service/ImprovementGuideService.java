package com.accessibility.platform.guide.service;

import com.accessibility.platform.analysis.domain.IssueResult;
import com.accessibility.platform.analysis.repository.IssueResultRepository;
import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.guide.domain.ImprovementGuide;
import com.accessibility.platform.guide.dto.ImprovementGuideCreateRequest;
import com.accessibility.platform.guide.dto.ImprovementGuideResponse;
import com.accessibility.platform.guide.repository.ImprovementGuideRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class ImprovementGuideService {

    private final ImprovementGuideRepository improvementGuideRepository;
    private final IssueResultRepository issueResultRepository;

    @Transactional
    public ImprovementGuideResponse createGuide(ImprovementGuideCreateRequest request) {
        IssueResult issueResult = issueResultRepository.findById(request.issueResultId())
                .orElseThrow(ResourceNotFoundException::new);

        ImprovementGuide guide = new ImprovementGuide(
                issueResult,
                request.guideTitle(),
                request.content(),
                request.referenceUrl()
        );
        return ImprovementGuideResponse.from(improvementGuideRepository.save(guide));
    }

    public ImprovementGuideResponse findByIssueId(Long issueResultId) {
        ImprovementGuide guide = improvementGuideRepository.findByIssueResultId(issueResultId)
                .orElseThrow(ResourceNotFoundException::new);
        return ImprovementGuideResponse.from(guide);
    }
}
