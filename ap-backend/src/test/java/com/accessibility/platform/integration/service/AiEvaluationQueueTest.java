package com.accessibility.platform.integration.service;

import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;

import java.io.IOException;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class AiEvaluationQueueTest {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void nextRequestStartsWithoutAnyResultReadEvenWhenPreviousFails(boolean firstFails) throws Exception {
        var requests = mock(EvaluationRequestRepository.class);
        var transactions = mock(PlatformTransactionManager.class);
        when(transactions.getTransaction(any())).thenAnswer(call -> new SimpleTransactionStatus());
        var first = new EvaluationRequest(null, "first");
        var second = new EvaluationRequest(null, "second");
        when(requests.findByIdForUpdate(1L)).thenReturn(Optional.of(first));
        when(requests.findByIdForUpdate(2L)).thenReturn(Optional.of(second));
        var runner = spy(new AiEvaluationRunnerService(requests, mock(ScoreResultRepository.class),
                transactions, new MockEnvironment(), "unused", 30));
        var firstStarted = new CountDownLatch(1);
        var releaseFirst = new CountDownLatch(1);
        var secondStarted = new CountDownLatch(1);
        var releaseSecond = new CountDownLatch(1);
        var finished = new CountDownLatch(1);
        doAnswer(call -> {
            if ((Long) call.getArgument(0) == 1L) {
                firstStarted.countDown();
                assertThat(releaseFirst.await(5, TimeUnit.SECONDS)).isTrue();
                if (firstFails) throw new IOException("fixture failure");
                first.changeStatus(EvaluationRequestStatus.COMPLETED);
            } else {
                secondStarted.countDown();
                assertThat(releaseSecond.await(5, TimeUnit.SECONDS)).isTrue();
                second.changeStatus(EvaluationRequestStatus.COMPLETED);
                finished.countDown();
            }
            return null;
        }).when(runner).executeAnalysisScript(anyLong(), anyString());
        runner.init();
        try {
            runner.runEvaluationAsync(1L, "https://first.example");
            assertThat(firstStarted.await(5, TimeUnit.SECONDS)).isTrue();
            runner.runEvaluationAsync(2L, "https://second.example");
            assertThat(first.getStatus()).isEqualTo(EvaluationRequestStatus.IN_PROGRESS);
            assertThat(second.getStatus()).isEqualTo(EvaluationRequestStatus.PENDING);
            assertThat(secondStarted.getCount()).isEqualTo(1);
            releaseFirst.countDown();
            assertThat(secondStarted.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(first.getStatus()).isEqualTo(firstFails ? EvaluationRequestStatus.FAILED : EvaluationRequestStatus.COMPLETED);
            assertThat(second.getStatus()).isEqualTo(EvaluationRequestStatus.IN_PROGRESS);
            releaseSecond.countDown();
            assertThat(finished.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(second.getStatus()).isEqualTo(EvaluationRequestStatus.COMPLETED);
            verify(runner).executeAnalysisScript(1L, "https://first.example");
            verify(runner).executeAnalysisScript(2L, "https://second.example");
        } finally {
            releaseFirst.countDown();
            releaseSecond.countDown();
            runner.destroy();
        }
    }
}
