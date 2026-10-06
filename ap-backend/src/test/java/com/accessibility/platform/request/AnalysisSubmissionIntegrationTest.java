package com.accessibility.platform.request;

import com.accessibility.platform.common.exception.BusinessException;
import com.accessibility.platform.integration.service.AiEvaluationRunnerService;
import com.accessibility.platform.request.dto.EvaluateUrlRequest;
import com.accessibility.platform.request.dto.EvaluationRequestCreateRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.request.service.AnalysisSubmissionService;
import com.accessibility.platform.request.service.EvaluationRequestService;
import com.accessibility.platform.target.service.FaviconService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

@SpringBootTest
@org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AnalysisSubmissionIntegrationTest {
    @Autowired AnalysisSubmissionService submissions;
    @Autowired EvaluationRequestService requests;
    @Autowired EvaluationRequestRepository repository;
    @Autowired com.accessibility.platform.target.repository.EvaluationTargetRepository targets;
    @Autowired org.springframework.test.web.servlet.MockMvc mvc;
    @MockitoBean AiEvaluationRunnerService runner;
    @MockitoBean FaviconService favicons;

    @Test
    void concurrentRetriesCreateExactlyOneJobAndCanRecoverTheReceipt() throws Exception {
        String key = UUID.randomUUID().toString();
        var input = new EvaluateUrlRequest("https://idempotent.example/" + key);
        long before = repository.count();
        try (var pool = Executors.newFixedThreadPool(4)) {
            var gate = new CountDownLatch(1);
            var futures = java.util.stream.IntStream.range(0, 4).mapToObj(i -> pool.submit(() -> {
                gate.await();
                return submissions.evaluate(input, key);
            })).toList();
            gate.countDown();
            var first = futures.getFirst().get(30, TimeUnit.SECONDS);
            for (var future : futures) assertThat(future.get(30, TimeUnit.SECONDS).id()).isEqualTo(first.id());
            assertThat(submissions.find(key).id()).isEqualTo(first.id());
            assertThat(repository.count()).isEqualTo(before + 1);
            verify(runner, times(1)).runEvaluationAsync(first.id(), input.url());
        }
    }

    @Test
    void conflictingPayloadsAndKindsCannotReuseAKey() {
        String key = UUID.randomUUID().toString();
        var first = submissions.evaluate(new EvaluateUrlRequest("https://conflict.example"), key);
        assertThatThrownBy(() -> submissions.evaluate(new EvaluateUrlRequest("https://different.example"), key)).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> submissions.create(new EvaluationRequestCreateRequest(first.evaluationTargetId(), "rescan"), key)).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> submissions.find("bad-key")).isInstanceOf(BusinessException.class);
        assertThat(submissions.find(UUID.randomUUID().toString())).isNull();
        String rescanKey = UUID.randomUUID().toString();
        var input = new EvaluationRequestCreateRequest(first.evaluationTargetId(), "rescan");
        var rescan = submissions.create(input, rescanKey);
        assertThat(submissions.create(input, rescanKey).id()).isEqualTo(rescan.id());
        verify(runner, times(1)).runEvaluationAsync(rescan.id(), "https://conflict.example");
    }

    @Test
    void httpContractAdvertisesSupportAndPreservesKeyedReceipts() throws Exception {
        String key = UUID.randomUUID().toString();
        var response = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/requests/evaluate")
                .header("Idempotency-Key", key).contentType("application/json").content("{\"url\":\"https://http-contract.example/\"}"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk()).andReturn();
        long id = new com.fasterxml.jackson.databind.ObjectMapper().readTree(response.getResponse().getContentAsString()).path("data").path("id").asLong();
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/requests/attempts/" + key))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.data.id").value(id));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/dashboard/overview"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.data.analysisProtocolVersion").value(1));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/requests/statuses").param("ids", id + ",99999999"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.data[0].outcome").value("FOUND"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.data[1].outcome").value("NOT_FOUND"));
    }

    @Test
    void batchPreservesEachIdAndDoesNotTreatMissingAsFailed() {
        var first = submissions.evaluate(new EvaluateUrlRequest("https://batch.example"), UUID.randomUUID().toString());
        var result = requests.findStatuses(List.of(first.id(), Long.MAX_VALUE));
        assertThat(result.getFirst().outcome()).isEqualTo("FOUND");
        assertThat(result.getFirst().request().id()).isEqualTo(first.id());
        assertThat(result.getLast().outcome()).isEqualTo("NOT_FOUND");
        assertThat(result.getLast().request()).isNull();
        assertThatThrownBy(() -> requests.findStatuses(List.of(first.id(), first.id()))).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> requests.findStatuses(java.util.stream.LongStream.rangeClosed(1, 101).boxed().toList())).isInstanceOf(BusinessException.class);
    }

    @Test
    void inactiveAndDeletedTargetsStopTrackingWithoutChangingJobStatus() {
        var first = submissions.evaluate(new EvaluateUrlRequest("https://removed.example"), UUID.randomUUID().toString());
        var target = targets.findById(first.evaluationTargetId()).orElseThrow();
        target.deactivate();
        targets.saveAndFlush(target);
        assertThat(requests.findStatuses(List.of(first.id())).getFirst().outcome()).isEqualTo("REMOVED");
        target.markDeleted();
        targets.saveAndFlush(target);
        assertThat(requests.findStatuses(List.of(first.id())).getFirst().request()).isNull();
        assertThat(repository.findById(first.id()).orElseThrow().getStatus().name()).isEqualTo("PENDING");
    }
}
