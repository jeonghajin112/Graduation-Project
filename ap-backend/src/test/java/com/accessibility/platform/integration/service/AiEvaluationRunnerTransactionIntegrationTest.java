package com.accessibility.platform.integration.service;

import com.accessibility.platform.analysis.repository.AnalysisResultRepository;
import com.accessibility.platform.capturemetadata.domain.EvaluationCaptureMetadata;
import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.common.exception.ErrorCode;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.dto.EvaluationRequestStatusUpdateRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.request.service.EvaluationRequestService;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.LocalDateTime;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AiEvaluationRunnerTransactionIntegrationTest {

    @Autowired
    AiEvaluationRunnerService runnerService;

    @Autowired
    OrganizationRepository organizationRepository;

    @Autowired
    EvaluationTargetRepository targetRepository;

    @Autowired
    EvaluationRequestRepository requestRepository;

    @Autowired
    ScoreResultRepository scoreResultRepository;

    @Autowired
    AnalysisResultRepository analysisResultRepository;

    @Autowired
    EvaluationCaptureMetadataRepository captureMetadataRepository;

    @Autowired
    AiEvaluationIngestionService ingestionService;

    @Autowired
    EvaluationRequestService evaluationRequestService;

    @Autowired
    MockMvc mockMvc;

    @Autowired
    PlatformTransactionManager transactionManager;

    @Test
    void executorRejectionAfterCommitPersistsFailedStatusInNewTransaction() {
        runnerService.destroy();
        TransactionTemplate transactionTemplate = new TransactionTemplate(transactionManager);

        Long requestId = transactionTemplate.execute(status -> {
            Organization organization = organizationRepository.save(new Organization(
                    "Rejected runner transaction test",
                    OrganizationType.ETC,
                    null,
                    null
            ));
            EvaluationTarget target = targetRepository.save(new EvaluationTarget(
                    organization,
                    "Rejected runner target",
                    TargetType.WEB,
                    "https://example.com/rejected-runner",
                    null,
                    null
            ));
            EvaluationRequest request = requestRepository.save(new EvaluationRequest(
                    target,
                    "executor rejection after commit"
            ));

            runnerService.runEvaluationAsync(request.getId(), target.getAccessUrl());
            return request.getId();
        });

        EvaluationRequest savedRequest = transactionTemplate.execute(status ->
                requestRepository.findById(requestId).orElseThrow()
        );
        assertThat(savedRequest.getStatus()).isEqualTo(EvaluationRequestStatus.FAILED);
    }

    @Test
    void rejectedRunnerCannotDowngradeACompletedIngestion() {
        runnerService.destroy();
        TransactionTemplate transactionTemplate = new TransactionTemplate(transactionManager);

        Long requestId = transactionTemplate.execute(status -> createRequest(
                "Completed ingestion before rejection",
                "https://example.com/completed-before-rejection"
        ).getId());

        ingestionService.save("""
                {
                  "url":"https://example.com/completed-before-rejection",
                  "request_id":%d,
                  "total_score":88,
                  "score_breakdown":{"module_scores":{"rule_based":88}}
                }
                """.formatted(requestId));

        runnerService.runEvaluationAsync(
                requestId,
                "https://example.com/completed-before-rejection"
        );

        EvaluationRequest savedRequest = transactionTemplate.execute(status ->
                requestRepository.findById(requestId).orElseThrow()
        );
        assertThat(savedRequest.getStatus()).isEqualTo(EvaluationRequestStatus.COMPLETED);
        assertThat(scoreResultRepository.findByEvaluationRequestId(requestId)).isPresent();
    }

    @Test
    void completedRequestStatusPatchReturnsConflictAndPreservesResult() throws Exception {
        TransactionTemplate transactionTemplate = new TransactionTemplate(transactionManager);
        Long requestId = transactionTemplate.execute(status -> createRequest(
                "Completed request API transition",
                "https://example.com/completed-api-transition"
        ).getId());
        ingestionService.save(resultJson(
                requestId,
                "https://example.com/completed-api-transition",
                77
        ));
        Long originalScoreId = scoreResultRepository.findByEvaluationRequestId(requestId)
                .orElseThrow()
                .getId();

        mockMvc.perform(patch("/api/requests/{id}/status", requestId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"IN_PROGRESS\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.message").value(
                        ErrorCode.INVALID_STATUS_TRANSITION.getMessage()
                ));

        EvaluationRequest savedRequest = transactionTemplate.execute(status ->
                requestRepository.findById(requestId).orElseThrow()
        );
        assertThat(savedRequest.getStatus()).isEqualTo(EvaluationRequestStatus.COMPLETED);
        assertThat(scoreResultRepository.findByEvaluationRequestId(requestId).orElseThrow().getId())
                .isEqualTo(originalScoreId);
    }

    @Test
    void duplicateIngestionForCompletedRequestPreservesEveryFinalizedResult() {
        TransactionTemplate transactionTemplate = new TransactionTemplate(transactionManager);
        String url = "https://example.com/duplicate-completed-ingestion";
        Long requestId = transactionTemplate.execute(status -> createRequest(
                "Duplicate completed ingestion",
                url
        ).getId());
        ingestionService.save(resultJson(requestId, url, 55));

        Long originalScoreId = scoreResultRepository.findByEvaluationRequestId(requestId)
                .orElseThrow()
                .getId();
        List<Long> originalAnalysisIds = analysisResultRepository
                .findByEvaluationRequestId(requestId)
                .stream()
                .map(result -> result.getId())
                .toList();
        assertThat(originalAnalysisIds).hasSize(3);
        Long originalCaptureMetadataId = transactionTemplate.execute(status -> {
            EvaluationRequest request = requestRepository.findById(requestId).orElseThrow();
            return captureMetadataRepository.saveAndFlush(new EvaluationCaptureMetadata(
                    request,
                    url,
                    url,
                    LocalDateTime.of(2026, 9, 1, 13, 0),
                    1280,
                    720,
                    1.0,
                    1280,
                    1200
            )).getId();
        });

        assertThatThrownBy(() -> ingestionService.save(resultJson(requestId, url, 99)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("terminal request")
                .hasMessageContaining("COMPLETED");

        EvaluationRequest savedRequest = requestRepository.findById(requestId).orElseThrow();
        assertThat(savedRequest.getStatus()).isEqualTo(EvaluationRequestStatus.COMPLETED);
        assertThat(scoreResultRepository.findByEvaluationRequestId(requestId).orElseThrow().getId())
                .isEqualTo(originalScoreId);
        assertThat(analysisResultRepository.findByEvaluationRequestId(requestId))
                .extracting(result -> result.getId())
                .containsExactlyInAnyOrderElementsOf(originalAnalysisIds);
        assertThat(captureMetadataRepository.findByEvaluationRequestId(requestId).orElseThrow().getId())
                .isEqualTo(originalCaptureMetadataId);
    }

    @Test
    void lateIngestionWaitsForConcurrentFailureAndCannotResurrectRequest() throws Exception {
        TransactionTemplate transactionTemplate = new TransactionTemplate(transactionManager);
        Long requestId = transactionTemplate.execute(status -> createRequest(
                "Concurrent failure before ingestion",
                "https://example.com/concurrent-failure"
        ).getId());
        ingestionService.save(resultJson(
                requestId,
                "https://example.com/concurrent-failure",
                64
        ));
        Long originalScoreId = scoreResultRepository.findByEvaluationRequestId(requestId)
                .orElseThrow()
                .getId();
        transactionTemplate.executeWithoutResult(status -> {
            EvaluationRequest request = requestRepository.findByIdForUpdate(requestId).orElseThrow();
            request.changeStatus(EvaluationRequestStatus.IN_PROGRESS);
        });
        String lateResultJson = resultJson(
                requestId,
                "https://example.com/concurrent-failure",
                91
        );

        ExecutorService workers = Executors.newFixedThreadPool(2);
        CountDownLatch failureRowLocked = new CountDownLatch(1);
        CountDownLatch releaseFailureTransaction = new CountDownLatch(1);
        CountDownLatch ingestionStarted = new CountDownLatch(1);

        try {
            Future<?> failure = workers.submit(() -> transactionTemplate.executeWithoutResult(status -> {
                evaluationRequestService.updateStatus(
                        requestId,
                        new EvaluationRequestStatusUpdateRequest(EvaluationRequestStatus.FAILED)
                );
                failureRowLocked.countDown();
                try {
                    if (!releaseFailureTransaction.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Timed out waiting to release failure transaction");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                }
            }));

            assertThat(failureRowLocked.await(5, TimeUnit.SECONDS)).isTrue();
            Future<?> ingestion = workers.submit(() -> {
                ingestionStarted.countDown();
                ingestionService.save(lateResultJson);
            });
            assertThat(ingestionStarted.await(5, TimeUnit.SECONDS)).isTrue();

            assertThatThrownBy(() -> ingestion.get(200, TimeUnit.MILLISECONDS))
                    .isInstanceOf(TimeoutException.class);

            releaseFailureTransaction.countDown();
            failure.get(5, TimeUnit.SECONDS);
            assertThatThrownBy(() -> ingestion.get(5, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .hasCauseInstanceOf(IllegalStateException.class);
        } finally {
            releaseFailureTransaction.countDown();
            workers.shutdownNow();
            workers.awaitTermination(5, TimeUnit.SECONDS);
        }

        EvaluationRequest savedRequest = transactionTemplate.execute(status ->
                requestRepository.findById(requestId).orElseThrow()
        );
        assertThat(savedRequest.getStatus()).isEqualTo(EvaluationRequestStatus.FAILED);
        assertThat(scoreResultRepository.findByEvaluationRequestId(requestId).orElseThrow().getId())
                .isEqualTo(originalScoreId);
    }

    private String resultJson(Long requestId, String url, int totalScore) {
        return """
                {
                  "url":"%s",
                  "request_id":%d,
                  "total_score":%d,
                  "score_breakdown":{"module_scores":{"rule_based":%d}}
                }
                """.formatted(url, requestId, totalScore, totalScore);
    }

    private EvaluationRequest createRequest(String note, String url) {
        Organization organization = organizationRepository.save(new Organization(
                "Runner transaction test " + note,
                OrganizationType.ETC,
                null,
                null
        ));
        EvaluationTarget target = targetRepository.save(new EvaluationTarget(
                organization,
                "Runner transaction target",
                TargetType.WEB,
                url,
                null,
                null
        ));
        return requestRepository.save(new EvaluationRequest(target, note));
    }
}
