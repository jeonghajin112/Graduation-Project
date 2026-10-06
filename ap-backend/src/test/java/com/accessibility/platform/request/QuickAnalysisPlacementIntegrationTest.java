package com.accessibility.platform.request;

import com.accessibility.platform.dashboard.service.DashboardQueryService;
import com.accessibility.platform.integration.service.AiEvaluationRunnerService;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.organization.service.ImportedOrganizationService;
import com.accessibility.platform.request.dto.EvaluateUrlRequest;
import com.accessibility.platform.request.service.EvaluationRequestService;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import com.accessibility.platform.target.service.FaviconService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;

@SpringBootTest
@Transactional
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class QuickAnalysisPlacementIntegrationTest {
    @Autowired EvaluationRequestService requests;
    @Autowired OrganizationRepository organizations;
    @Autowired EvaluationTargetRepository targets;
    @Autowired DashboardQueryService dashboard;
    @Autowired ImportedOrganizationService imports;
    @MockitoBean AiEvaluationRunnerService runner;
    @MockitoBean FaviconService favicons;

    @Test
    void urlReceiptsUseInternalStorageAndRemainIdentifiableBeforeCompletion() {
        var first = requests.createForUrl(new EvaluateUrlRequest("https://quick.example/one"));
        var second = requests.createForUrl(new EvaluateUrlRequest("https://quick.example/two"));
        var repeat = requests.createForUrl(new EvaluateUrlRequest("https://quick.example/one"));
        assertThat(first.quickAnalysis()).isTrue();
        assertThat(repeat.evaluationTargetId()).isEqualTo(first.evaluationTargetId());
        assertThat(organizations.findAll()).hasSize(1).allMatch(Organization::isSystemManaged);
        assertThat(dashboard.getOverview().organizations()).hasSize(1)
                .allMatch(organization -> organization.systemManaged());
        assertThat(dashboard.getOverview().evaluationRequests()).hasSize(3)
                .allMatch(request -> request.quickAnalysis() && request.status().name().equals("PENDING"));
        verify(runner).runEvaluationAsync(second.id(), "https://quick.example/two");
    }

    @Test
    void quickAnalysisOfAnExistingProjectPageDoesNotCreateOrReclassifyAProject() {
        var project = organizations.save(new Organization("접근성 분석", OrganizationType.ETC, null,
                "AI-module imported evaluation results"));
        var target = targets.save(new EvaluationTarget(project, "Existing page", TargetType.WEB,
                "https://project.example/", null));
        var receipt = requests.createForUrl(new EvaluateUrlRequest(target.getAccessUrl()));
        assertThat(receipt.evaluationTargetId()).isEqualTo(target.getId());
        assertThat(receipt.quickAnalysis()).isTrue();
        assertThat(organizations.count()).isEqualTo(1);
        assertThat(project.isSystemManaged()).isFalse();
    }

    @Test
    void legacyBucketIsReusedButUserProjectsWithTheSameNameStayVisible() {
        var userProject = organizations.save(new Organization(Organization.IMPORTED_NAME,
                OrganizationType.ETC, null, "User project"));
        var legacy = organizations.save(new Organization(Organization.IMPORTED_NAME,
                OrganizationType.ETC, null, "AI-module imported evaluation results"));
        assertThat(imports.getOrCreate().getId()).isEqualTo(legacy.getId());
        assertThat(userProject.isSystemManaged()).isFalse();
        assertThat(legacy.isSystemManaged()).isTrue();
        assertThat(organizations.count()).isEqualTo(2);
    }

    @Test
    void deletedProjectPagesAreNotReusedForNewQuickAnalysis() {
        var project = organizations.save(new Organization("Removed", OrganizationType.ETC, null, null));
        var target = targets.save(new EvaluationTarget(project, "Old page", TargetType.WEB,
                "https://removed.example/", null));
        project.deactivate();
        var receipt = requests.createForUrl(new EvaluateUrlRequest(target.getAccessUrl()));
        assertThat(receipt.evaluationTargetId()).isNotEqualTo(target.getId());
        assertThat(dashboard.getOverview().evaluationRequests()).extracting(request -> request.id())
                .contains(receipt.id());
    }
}
