package com.accessibility.platform.livereport;

import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LiveReportLaunchServiceTest {

    @Test
    void prefersCapturedFinalUrlSoTheLiveSessionStartsFromTheAnalyzedPage() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationCaptureMetadataRepository metadata = mock(EvaluationCaptureMetadataRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportSessionService.LiveReportSession expected = mock(LiveReportSessionService.LiveReportSession.class);
        when(metadata.findFinalUrlByRequestId(7L)).thenReturn(Optional.of("https://example.com/final"));
        when(sessions.create(7L, "https://example.com/final")).thenReturn(expected);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, metadata, sessions);

        assertThat(service.createForRequest(7L)).isSameAs(expected);
        verify(requests, never()).findTargetUrlById(7L);
    }

    @Test
    void fallsBackToRegisteredTargetWhenCaptureMetadataIsUnavailable() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationCaptureMetadataRepository metadata = mock(EvaluationCaptureMetadataRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportSessionService.LiveReportSession expected = mock(LiveReportSessionService.LiveReportSession.class);
        when(metadata.findFinalUrlByRequestId(8L)).thenReturn(Optional.empty());
        when(requests.findTargetUrlById(8L)).thenReturn(Optional.of("https://example.org/start"));
        when(sessions.create(8L, "https://example.org/start")).thenReturn(expected);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, metadata, sessions);

        assertThat(service.createForRequest(8L)).isSameAs(expected);
    }

    @Test
    void fallsBackOnceToRegisteredTargetWhenLegacyCapturedFinalUrlIsRejected() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationCaptureMetadataRepository metadata = mock(EvaluationCaptureMetadataRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportSessionService.LiveReportSession expected = mock(LiveReportSessionService.LiveReportSession.class);
        when(metadata.findFinalUrlByRequestId(9L)).thenReturn(Optional.of("http://legacy.example/final"));
        when(requests.findTargetUrlById(9L)).thenReturn(Optional.of("https://example.com/start"));
        when(sessions.create(9L, "http://legacy.example/final")).thenThrow(new LiveReportException(
                HttpStatus.BAD_REQUEST,
                "Only HTTPS URLs are allowed"
        ));
        when(sessions.create(9L, "https://example.com/start")).thenReturn(expected);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, metadata, sessions);

        assertThat(service.createForRequest(9L)).isSameAs(expected);
        var ordered = inOrder(sessions);
        ordered.verify(sessions).create(9L, "http://legacy.example/final");
        ordered.verify(sessions).create(9L, "https://example.com/start");
        ordered.verifyNoMoreInteractions();
    }

    @Test
    void doesNotRetryOperationalSessionFailuresAgainstTheRegisteredTarget() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationCaptureMetadataRepository metadata = mock(EvaluationCaptureMetadataRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportException failure = new LiveReportException(
                HttpStatus.TOO_MANY_REQUESTS,
                "Too many live report sessions are active"
        );
        when(metadata.findFinalUrlByRequestId(10L)).thenReturn(Optional.of("https://example.com/final"));
        when(sessions.create(10L, "https://example.com/final")).thenThrow(failure);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, metadata, sessions);

        assertThatThrownBy(() -> service.createForRequest(10L)).isSameAs(failure);
        verify(requests, never()).findTargetUrlById(10L);
    }
}
