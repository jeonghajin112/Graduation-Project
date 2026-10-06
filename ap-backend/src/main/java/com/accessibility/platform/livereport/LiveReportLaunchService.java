package com.accessibility.platform.livereport;

import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class LiveReportLaunchService {
    private final EvaluationRequestRepository evaluationRequestRepository;
    private final EvaluationCaptureMetadataRepository captureMetadataRepository;
    private final LiveReportSessionService sessionService;

    public LiveReportSessionService.LiveReportSession createForRequest(long requestId) {
        String targetUrl = evaluationRequestRepository.findTargetUrlById(requestId)
                .filter(value -> !value.isBlank())
                .orElseGet(() -> captureMetadataRepository.findFinalUrlByRequestId(requestId)
                        .filter(value -> !value.isBlank())
                        .orElseThrow(ResourceNotFoundException::new));
        return sessionService.create(requestId, targetUrl);
    }

    public LiveReportSessionService.LiveReportSession renewForRequest(long requestId, UUID sessionId) {
        return sessionService.renew(sessionId, requestId);
    }
}
