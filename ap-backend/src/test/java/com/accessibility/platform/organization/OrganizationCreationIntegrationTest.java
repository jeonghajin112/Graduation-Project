package com.accessibility.platform.organization;

import com.accessibility.platform.common.exception.BusinessException;
import com.accessibility.platform.common.exception.ErrorCode;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.dto.OrganizationCreateRequest;
import com.accessibility.platform.organization.dto.OrganizationResponse;
import com.accessibility.platform.organization.dto.OrganizationUpdateRequest;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.organization.service.OrganizationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.AdditionalAnswers.delegatesTo;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class OrganizationCreationIntegrationTest {
    @Autowired OrganizationService service;
    @Autowired OrganizationRepository repository;
    @Autowired PlatformTransactionManager transactionManager;
    @Autowired MockMvc mockMvc;

    private final ObjectMapper json = new ObjectMapper();
    private final OrganizationCreateRequest request = new OrganizationCreateRequest(
            "프로젝트", OrganizationType.ETC, null, "설명"
    );

    @Test
    void requestsWithoutAKeyKeepTheExistingCreateBehavior() throws Exception {
        long firstId = createThroughApi(request, null);
        long secondId = createThroughApi(request, null);
        assertThat(secondId).isNotEqualTo(firstId);
    }

    @Test
    void repeatedKeyReturnsTheSameOrganizationWithoutExposingInternalFields() throws Exception {
        String key = UUID.randomUUID().toString();
        long firstId = createThroughApi(request, key);

        assertThat(createThroughApi(request, key.toUpperCase())).isEqualTo(firstId);
        assertThat(repository.findByCreationIdempotencyKey(key)).isPresent();
    }

    @Test
    void dashboardCorsPreflightAllowsTheIdempotencyHeader() throws Exception {
        mockMvc.perform(options("/api/organizations")
                        .header("Origin", "http://localhost:5173")
                        .header("Access-Control-Request-Method", "POST")
                        .header("Access-Control-Request-Headers", "Content-Type, Idempotency-Key"))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", "http://localhost:5173"))
                .andExpect(header().string("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "not-a-uuid", "1-1-1-1-1", "00000000-0000-0000-0000-000000000001,other"})
    void malformedKeysReturnBadRequest(String key) throws Exception {
        mockMvc.perform(post("/api/organizations")
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(request)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.message").value(ErrorCode.INVALID_IDEMPOTENCY_KEY.getMessage()));
    }

    @Test
    void changingAnyOriginalFieldReturnsConflict() throws Exception {
        String key = UUID.randomUUID().toString();
        long originalId = createThroughApi(request, key);
        var differentRequests = List.of(
                new OrganizationCreateRequest("다른 이름", request.type(), null, request.description()),
                new OrganizationCreateRequest(request.name(), OrganizationType.PUBLIC_AGENCY, null, request.description()),
                new OrganizationCreateRequest(request.name(), request.type(), "", request.description()),
                new OrganizationCreateRequest(request.name(), request.type(), null, "다른 설명")
        );

        for (var differentRequest : differentRequests) {
            mockMvc.perform(post("/api/organizations")
                            .header("Idempotency-Key", key)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(json.writeValueAsString(differentRequest)))
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.success").value(false))
                    .andExpect(jsonPath("$.message").value(ErrorCode.IDEMPOTENCY_KEY_CONFLICT.getMessage()));
        }
        assertThat(createThroughApi(request, key)).isEqualTo(originalId);
    }

    @Test
    void retriesUsePersistedOriginalPayloadAfterRenameAndServiceRecreation() {
        String key = UUID.randomUUID().toString();
        OrganizationResponse created = service.create(request, key);
        service.update(created.id(), new OrganizationUpdateRequest("새 이름", OrganizationType.ETC, null, "새 설명"));
        var restartedService = new OrganizationService(repository, transactionManager);

        OrganizationResponse retried = restartedService.create(request, key);
        assertThat(retried.id()).isEqualTo(created.id());
        assertThat(retried.name()).isEqualTo("새 이름");
        assertThatThrownBy(() -> restartedService.create(
                new OrganizationCreateRequest("새 이름", OrganizationType.ETC, null, "새 설명"), key
        )).isInstanceOfSatisfying(BusinessException.class,
                exception -> assertThat(exception.getErrorCode()).isEqualTo(ErrorCode.IDEMPOTENCY_KEY_CONFLICT));
    }

    @Test
    void failedTransactionDoesNotReserveTheKey() {
        String key = UUID.randomUUID().toString();
        var invalidRequest = new OrganizationCreateRequest("x".repeat(101), OrganizationType.ETC, null, null);

        assertThatThrownBy(() -> service.create(invalidRequest, key))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(repository.findByCreationIdempotencyKey(key)).isEmpty();
        assertThat(service.create(request, key).id()).isNotNull();
    }

    @Test
    void concurrentIdenticalRequestsCommitOneRowAndBothReturnItsId() throws Exception {
        long countBefore = repository.count();
        List<Object> outcomes = createConcurrently(request, request);

        assertThat(outcomes).allSatisfy(outcome -> assertThat(outcome).isInstanceOf(OrganizationResponse.class));
        assertThat(((OrganizationResponse) outcomes.get(0)).id())
                .isEqualTo(((OrganizationResponse) outcomes.get(1)).id());
        assertThat(repository.count()).isEqualTo(countBefore + 1);
    }

    @Test
    void concurrentDifferentRequestsCommitOneRowAndRejectTheOtherPayload() throws Exception {
        long countBefore = repository.count();
        List<Object> outcomes = createConcurrently(request,
                new OrganizationCreateRequest("다른 요청", OrganizationType.ETC, null, null));

        assertThat(outcomes.stream().filter(OrganizationResponse.class::isInstance)).hasSize(1);
        assertThat(outcomes.stream().filter(BusinessException.class::isInstance)
                .map(BusinessException.class::cast).map(BusinessException::getErrorCode))
                .containsExactly(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);
        assertThat(repository.count()).isEqualTo(countBefore + 1);
    }

    private long createThroughApi(OrganizationCreateRequest body, String key) throws Exception {
        var builder = post("/api/organizations")
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(body));
        if (key != null) {
            builder.header("Idempotency-Key", key);
        }
        var response = mockMvc.perform(builder)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.creationIdempotencyKey").doesNotExist())
                .andExpect(jsonPath("$.data.creationRequestHash").doesNotExist())
                .andReturn().getResponse();
        return json.readTree(response.getContentAsString()).path("data").path("id").asLong();
    }

    private List<Object> createConcurrently(OrganizationCreateRequest first, OrganizationCreateRequest second)
            throws Exception {
        String key = UUID.randomUUID().toString();
        CountDownLatch bothReadsCompleted = new CountDownLatch(2);
        OrganizationRepository concurrentRepository = mock(OrganizationRepository.class, delegatesTo(repository));
        doAnswer(invocation -> {
            var existing = repository.findByCreationIdempotencyKey(key);
            if (existing.isEmpty()) {
                bothReadsCompleted.countDown();
                if (!bothReadsCompleted.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Concurrent create did not reach its initial read");
                }
            }
            return existing;
        }).when(concurrentRepository).findByCreationIdempotencyKey(key);
        var concurrentService = new OrganizationService(concurrentRepository, transactionManager);

        try (var workers = Executors.newFixedThreadPool(2)) {
            var futures = List.of(
                    workers.submit(() -> concurrentService.create(first, key)),
                    workers.submit(() -> concurrentService.create(second, key))
            );
            List<Object> outcomes = new ArrayList<>();
            for (var future : futures) {
                try {
                    outcomes.add(future.get(10, TimeUnit.SECONDS));
                } catch (ExecutionException exception) {
                    outcomes.add(exception.getCause());
                }
            }
            return outcomes;
        }
    }
}
