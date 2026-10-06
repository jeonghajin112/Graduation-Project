package com.accessibility.platform.request;

import com.accessibility.platform.integration.service.AiEvaluationRunnerService;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.service.ImportedOrganizationService;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.dto.EvaluateUrlRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.request.service.EvaluationRequestService;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetStatus;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import com.accessibility.platform.target.service.EvaluationTargetService;
import com.accessibility.platform.target.service.FaviconService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class QuickAnalysisFaviconTest {
    private static final String URL = "https://slow.example/";

    private final EvaluationRequestRepository requests = mock(EvaluationRequestRepository.class);
    private final EvaluationTargetRepository targets = mock(EvaluationTargetRepository.class);
    private final ImportedOrganizationService imports = mock(ImportedOrganizationService.class);
    private final FaviconService favicons = mock(FaviconService.class);
    private final EvaluationRequestService service = new EvaluationRequestService(requests,
            mock(EvaluationTargetService.class), targets, imports, mock(AiEvaluationRunnerService.class), favicons);

    @AfterEach
    void clearSynchronization() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void newPageReceiptDoesNotWaitForItsFaviconAndStoresItAfterCommit() {
        when(targets.findAllByAccessUrlOrderByIdDesc(URL)).thenReturn(List.of());
        when(imports.getOrCreate()).thenReturn(new Organization("Imported", OrganizationType.ETC, null, null));
        when(targets.save(any(EvaluationTarget.class))).thenAnswer(invocation -> {
            EvaluationTarget target = invocation.getArgument(0);
            ReflectionTestUtils.setField(target, "id", 7L);
            return target;
        });
        when(requests.save(any(EvaluationRequest.class))).thenAnswer(invocation -> invocation.getArgument(0));

        TransactionSynchronizationManager.initSynchronization();
        var receipt = service.createForUrl(new EvaluateUrlRequest(URL));

        assertThat(receipt.faviconUrl()).isNull();
        verify(favicons, never()).findFaviconUrl(anyString());
        verify(favicons, never()).findFaviconUrlInBackground(anyString(), any());

        TransactionSynchronizationManager.getSynchronizations().forEach(TransactionSynchronization::afterCommit);
        ArgumentCaptor<Consumer<String>> onFound = ArgumentCaptor.forClass(Consumer.class);
        verify(favicons).findFaviconUrlInBackground(eq(URL), onFound.capture());

        onFound.getValue().accept("/api/v1/favicons/abc.png");
        verify(targets).updateFaviconIfUrlUnchanged(7L, URL, "/api/v1/favicons/abc.png", TargetStatus.DELETED);
    }

    @Test
    void existingPageWithServableFaviconIsNotFetchedAgain() {
        var organization = new Organization("Project", OrganizationType.ETC, null, null);
        var target = new EvaluationTarget(organization, "Page", TargetType.WEB, URL, null, "/api/v1/favicons/abc.png");
        when(targets.findAllByAccessUrlOrderByIdDesc(URL)).thenReturn(List.of(target));
        when(favicons.hasServableFavicon("/api/v1/favicons/abc.png")).thenReturn(true);
        when(requests.save(any(EvaluationRequest.class))).thenAnswer(invocation -> invocation.getArgument(0));

        service.createForUrl(new EvaluateUrlRequest(URL));

        verify(favicons, never()).findFaviconUrl(anyString());
        verify(favicons, never()).findFaviconUrlInBackground(anyString(), any());
    }
}
