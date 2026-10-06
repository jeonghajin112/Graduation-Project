package com.accessibility.platform.target.service;

import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.target.controller.EvaluationTargetController;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class FaviconRefreshTest {
    @Test
    void refreshesOnlyFaviconAndPreservesItOnLookupFailure() {
        var organization = new Organization("Project", OrganizationType.ETC, null, null);
        var target = new EvaluationTarget(organization, "Page", TargetType.WEB,
                "https://example.com/", "Description", "https://example.com/old.ico");
        var targets = mock(EvaluationTargetRepository.class);
        var favicons = mock(FaviconService.class);
        when(targets.findById(1L)).thenReturn(Optional.of(target));
        when(targets.findWithOrganizationById(1L)).thenReturn(Optional.of(target));
        when(targets.updateFaviconIfUrlUnchanged(1L, target.getAccessUrl(), "https://example.com/64.png",
                com.accessibility.platform.target.domain.TargetStatus.DELETED)).thenAnswer(invocation -> {
            target.updateFaviconUrl(invocation.getArgument(2));
            return 1;
        });
        when(favicons.findFaviconUrl(target.getAccessUrl()))
                .thenReturn(Optional.of("https://example.com/64.png"), Optional.empty());
        var service = new EvaluationTargetService(targets, mock(OrganizationRepository.class), favicons);
        var controller = new EvaluationTargetController(service);

        controller.refreshFavicon(1L);
        assertThat(target.getFaviconUrl()).isEqualTo("https://example.com/64.png");
        controller.refreshFavicon(1L);
        assertThat(target.getFaviconUrl()).isEqualTo("https://example.com/64.png");
        assertThat(target.getName()).isEqualTo("Page");
        assertThat(target.getAccessUrl()).isEqualTo("https://example.com/");
        assertThat(target.getDescription()).isEqualTo("Description");
        assertThat(target.getOrganization()).isSameAs(organization);
    }
}
