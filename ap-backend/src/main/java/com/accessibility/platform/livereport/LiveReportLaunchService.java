package com.accessibility.platform.livereport;

import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
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
        var capturedFinalUrl = captureMetadataRepository.findFinalUrlByRequestId(requestId)
                .filter(value -> !value.isBlank());
        if (capturedFinalUrl.isEmpty()) {
            return sessionService.create(requestId, registeredTargetUrl(requestId));
        }

        try {
            return sessionService.create(requestId, capturedFinalUrl.orElseThrow());
        } catch (LiveReportException exception) {
            if (exception.getStatus() != HttpStatus.BAD_REQUEST) {
                throw exception;
            }
            // Historical artifact rows predate the current HTTPS-only live URL
            // policy. Retry only URL-policy rejections, once, through the same
            // session validator used for every ordinary launch.
            return sessionService.create(requestId, registeredTargetUrl(requestId));
        }
    }

    private String registeredTargetUrl(long requestId) {
        return evaluationRequestRepository.findTargetUrlById(requestId)
                .filter(value -> !value.isBlank())
                .orElseThrow(ResourceNotFoundException::new);
    }

    public LiveReportSessionService.LiveReportSession renewForRequest(long requestId, UUID sessionId) {
        return sessionService.renew(sessionId, requestId);
    }
}
