package com.accessibility.platform.livereport;

import com.accessibility.platform.artifact.repository.EvaluationArtifactRepository;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LiveReportLaunchServiceTest {

    @Test
    void prefersRegisteredTargetSoTheLiveSessionStartsFromTheCurrentPublicEntryPoint() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationArtifactRepository artifacts = mock(EvaluationArtifactRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportSessionService.LiveReportSession expected = mock(LiveReportSessionService.LiveReportSession.class);
        when(requests.findTargetUrlById(7L)).thenReturn(Optional.of("https://example.com/start"));
        when(sessions.create(7L, "https://example.com/start")).thenReturn(expected);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, artifacts, sessions);

        assertThat(service.createForRequest(7L)).isSameAs(expected);
        verify(artifacts, never()).findFinalUrlByRequestId(7L);
    }

    @Test
    void fallsBackToCapturedFinalUrlWhenTheRegisteredTargetIsUnavailable() {
        EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
        EvaluationArtifactRepository artifacts = mock(EvaluationArtifactRepository.class);
        LiveReportSessionService sessions = mock(LiveReportSessionService.class);
        LiveReportSessionService.LiveReportSession expected = mock(LiveReportSessionService.LiveReportSession.class);
        when(requests.findTargetUrlById(8L)).thenReturn(Optional.empty());
        when(artifacts.findFinalUrlByRequestId(8L)).thenReturn(Optional.of("https://example.org/final"));
        when(sessions.create(8L, "https://example.org/final")).thenReturn(expected);
        LiveReportLaunchService service = new LiveReportLaunchService(requests, artifacts, sessions);

        assertThat(service.createForRequest(8L)).isSameAs(expected);
    }
}
