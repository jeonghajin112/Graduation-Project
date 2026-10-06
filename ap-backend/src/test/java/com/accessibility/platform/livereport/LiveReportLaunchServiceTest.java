package com.accessibility.platform.livereport;

import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LiveReportLaunchServiceTest {

    @Test
    void prefersRegisteredTargetOverCapturedFinalUrl() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationCaptureMetadataRepository metadata = mock(EvaluationCaptureMetadataRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportSessionService.LiveReportSession expected = mock(LiveReportSessionService.LiveReportSession.class);
        when(requests.findTargetUrlById(7L)).thenReturn(Optional.of("https://example.com/start"));
        when(metadata.findFinalUrlByRequestId(7L)).thenReturn(Optional.of("https://example.com/final"));
        when(sessions.create(7L, "https://example.com/start")).thenReturn(expected);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, metadata, sessions);

        assertThat(service.createForRequest(7L)).isSameAs(expected);
        verify(metadata, never()).findFinalUrlByRequestId(7L);
    }

    @Test
    void fallsBackToCapturedFinalUrlWhenRegisteredTargetIsUnavailable() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationCaptureMetadataRepository metadata = mock(EvaluationCaptureMetadataRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportSessionService.LiveReportSession expected = mock(LiveReportSessionService.LiveReportSession.class);
        when(requests.findTargetUrlById(8L)).thenReturn(Optional.empty());
        when(metadata.findFinalUrlByRequestId(8L)).thenReturn(Optional.of("https://example.org/final"));
        when(sessions.create(8L, "https://example.org/final")).thenReturn(expected);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, metadata, sessions);

        assertThat(service.createForRequest(8L)).isSameAs(expected);
    }

    @Test
    void treatsBlankRegisteredTargetAsUnavailable() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationCaptureMetadataRepository metadata = mock(EvaluationCaptureMetadataRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportSessionService.LiveReportSession expected = mock(LiveReportSessionService.LiveReportSession.class);
        when(requests.findTargetUrlById(9L)).thenReturn(Optional.of("  "));
        when(metadata.findFinalUrlByRequestId(9L)).thenReturn(Optional.of("https://example.com/final"));
        when(sessions.create(9L, "https://example.com/final")).thenReturn(expected);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, metadata, sessions);

        assertThat(service.createForRequest(9L)).isSameAs(expected);
    }

    @Test
    void doesNotFallBackToCapturedFinalUrlWhenRegisteredTargetSessionCreationFails() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationCaptureMetadataRepository metadata = mock(EvaluationCaptureMetadataRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportException failure = new LiveReportException(
                HttpStatus.BAD_REQUEST,
                "Only HTTPS URLs are allowed"
        );
        when(requests.findTargetUrlById(10L)).thenReturn(Optional.of("https://example.com/start"));
        when(metadata.findFinalUrlByRequestId(10L)).thenReturn(Optional.of("https://example.com/final"));
        when(sessions.create(10L, "https://example.com/start")).thenThrow(failure);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, metadata, sessions);

        assertThatThrownBy(() -> service.createForRequest(10L)).isSameAs(failure);
        verify(metadata, never()).findFinalUrlByRequestId(10L);
    }
}
