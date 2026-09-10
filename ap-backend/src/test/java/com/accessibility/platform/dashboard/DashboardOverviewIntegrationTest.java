package com.accessibility.platform.dashboard;

import com.accessibility.platform.analysis.domain.AnalysisResult;
import com.accessibility.platform.analysis.domain.AnalysisStatus;
import com.accessibility.platform.analysis.domain.AnalyzerType;
import com.accessibility.platform.analysis.domain.IssueResult;
import com.accessibility.platform.analysis.domain.Severity;
import com.accessibility.platform.analysis.repository.AnalysisResultRepository;
import com.accessibility.platform.analysis.repository.IssueResultRepository;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.score.domain.ScoreResult;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.StreamSupport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
@TestPropertySource(properties = "spring.jpa.properties.hibernate.generate_statistics=true")
public class DashboardOverviewIntegrationTest {

    @Autowired
    MockMvc mockMvc;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Autowired
    EntityManager entityManager;

    @Autowired
    EntityManagerFactory entityManagerFactory;

    @Autowired
    JdbcTemplate jdbcTemplate;

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
    IssueResultRepository issueResultRepository;

    @Test
    void overviewReturnsOnlyActiveDirectoryAndAggregatedLatestIssues() throws Exception {
        ContractFixture fixture = createContractFixture();

        JsonNode data = overviewData();

        JsonNode organization = findById(data.path("organizations"), fixture.organizationId());
        assertThat(organization).isNotNull();
        assertThat(findById(organization.path("evaluationTargets"), fixture.activeTargetId())).isNotNull();
        assertThat(findById(organization.path("evaluationTargets"), fixture.tieTargetId())).isNotNull();
        assertThat(findById(organization.path("evaluationTargets"), fixture.zeroIssueTargetId())).isNotNull();
        assertThat(findById(organization.path("evaluationTargets"), fixture.inactiveTargetId())).isNull();
        assertThat(findById(organization.path("evaluationTargets"), fixture.deletedTargetId())).isNull();
        JsonNode emptyOrganization = findById(data.path("organizations"), fixture.emptyOrganizationId());
        assertThat(emptyOrganization).isNotNull();
        assertThat(emptyOrganization.path("evaluationTargets")).isEmpty();
        assertThat(findById(data.path("organizations"), fixture.inactiveOrganizationId())).isNull();

        assertThat(findById(data.path("evaluationRequests"), fixture.latestCompletedRequestId())).isNotNull();
        assertThat(findById(data.path("evaluationRequests"), fixture.previousCompletedRequestId())).isNotNull();
        assertThat(findById(data.path("evaluationRequests"), fixture.pendingRequestId())).isNotNull();
        assertThat(findById(data.path("evaluationRequests"), fixture.excludedRequestId())).isNull();

        JsonNode latestSummary = findById(data.path("resultSummaries"), "requestId", fixture.latestCompletedRequestId());
        JsonNode previousSummary = findById(data.path("resultSummaries"), "requestId", fixture.previousCompletedRequestId());
        assertThat(latestSummary.path("totalIssueCount").asLong()).isEqualTo(3);
        assertThat(latestSummary.path("criticalIssueCount").asLong()).isEqualTo(2);
        assertThat(latestSummary.path("totalScore").decimalValue()).isEqualByComparingTo("91.50");
        assertThat(previousSummary.path("totalIssueCount").asLong()).isEqualTo(1);
        assertThat(findById(data.path("resultSummaries"), "requestId", fixture.pendingRequestId())).isNull();

        JsonNode score = findById(data.path("scoreResults"), "evaluationRequestId", fixture.latestCompletedRequestId());
        assertThat(score).isNotNull();
        assertThat(fieldNames(score)).containsExactlyInAnyOrder(
                "id",
                "evaluationRequestId",
                "totalScore",
                "ruleScore",
                "aiScore",
                "cvScore",
                "cvStatus",
                "createdAt",
                "updatedAt"
        );
        assertThat(score.has("details")).isFalse();

        JsonNode latestCounts = findById(data.path("latestIssueCounts"), "evaluationTargetId", fixture.activeTargetId());
        assertThat(latestCounts.path("requestId").asLong()).isEqualTo(fixture.latestCompletedRequestId());
        assertThat(latestCounts.path("totalIssueCount").asLong()).isEqualTo(3);
        assertThat(latestCounts.path("criticalIssueCount").asLong()).isEqualTo(2);
        assertThat(latestCounts.path("highIssueCount").asLong()).isEqualTo(1);
        assertThat(latestCounts.path("mediumIssueCount").asLong()).isZero();
        assertThat(latestCounts.path("lowIssueCount").asLong()).isZero();
        assertThat(latestCounts.path("groups")).hasSize(2);
        JsonNode criticalGroup = StreamSupport.stream(latestCounts.path("groups").spliterator(), false)
                .filter(group -> group.path("severity").asText().equals("CRITICAL"))
                .findFirst()
                .orElseThrow();
        assertThat(criticalGroup.path("issueCode").asText()).isEqualTo("5.1.1");
        assertThat(criticalGroup.path("issueTitle").asText()).isEqualTo("대체 텍스트 누락");
        assertThat(criticalGroup.path("count").asLong()).isEqualTo(2);
        assertThat(latestCounts.toString())
                .doesNotContain("FULL DETAIL MUST NOT LEAK", "locator", "selector", "recommendation");

        JsonNode tieCounts = findById(data.path("latestIssueCounts"), "evaluationTargetId", fixture.tieTargetId());
        assertThat(tieCounts.path("requestId").asLong()).isEqualTo(fixture.tieNewerRequestId());
        JsonNode zeroCounts = findById(data.path("latestIssueCounts"), "evaluationTargetId", fixture.zeroIssueTargetId());
        assertThat(zeroCounts.path("requestId").asLong()).isEqualTo(fixture.zeroIssueRequestId());
        assertThat(zeroCounts.path("totalIssueCount").asLong()).isZero();
        assertThat(zeroCounts.path("groups")).isEmpty();
    }

    @Test
    void overviewQueryCountIsBoundedAndDoesNotGrowWithDataVolume() throws Exception {
        createScaleFixtures("small", 1);
        long smallQueryCount = overviewQueryCount();

        createScaleFixtures("large", 24);
        long largeQueryCount = overviewQueryCount();

        assertThat(smallQueryCount).isLessThanOrEqualTo(6);
        assertThat(largeQueryCount)
                .isEqualTo(smallQueryCount)
                .isLessThanOrEqualTo(6);
    }

    @Test
    void issueDetailQueryCountDoesNotGrowWithAnalysisCount() throws Exception {
        EvaluationRequest request = createRequest("issue-detail", true);
        addAnalysisWithIssue(request, AnalyzerType.RULE_BASED, "5.1.1", Severity.CRITICAL);
        long smallQueryCount = issueDetailQueryCount(request.getId(), 1);

        for (int index = 0; index < 18; index++) {
            addAnalysisWithIssue(
                    request,
                    index % 2 == 0 ? AnalyzerType.AI_TEXT : AnalyzerType.CV_VISION,
                    "detail-" + index,
                    Severity.MEDIUM
            );
        }
        long largeQueryCount = issueDetailQueryCount(request.getId(), 19);

        assertThat(smallQueryCount).isLessThanOrEqualTo(2);
        assertThat(largeQueryCount)
                .isEqualTo(smallQueryCount)
                .isLessThanOrEqualTo(2);
    }

    @Test
    void resultSummaryQueryCountDoesNotGrowWithAnalysisCount() throws Exception {
        EvaluationRequest request = createRequest("result-summary", true);
        addAnalysisWithIssue(request, AnalyzerType.RULE_BASED, "5.1.1", Severity.CRITICAL);
        long smallQueryCount = resultSummaryQueryCount(request.getId(), 1, 1);

        for (int index = 0; index < 18; index++) {
            addAnalysisWithIssue(
                    request,
                    index % 2 == 0 ? AnalyzerType.AI_TEXT : AnalyzerType.CV_VISION,
                    "summary-" + index,
                    Severity.MEDIUM
            );
        }
        long largeQueryCount = resultSummaryQueryCount(request.getId(), 19, 1);

        assertThat(smallQueryCount).isLessThanOrEqualTo(4);
        assertThat(largeQueryCount)
                .isEqualTo(smallQueryCount)
                .isLessThanOrEqualTo(4);
    }

    private ContractFixture createContractFixture() {
        Organization organization = organizationRepository.save(new Organization(
                "Dashboard contract organization",
                OrganizationType.ETC,
                "https://dashboard.example",
                "contract"
        ));
        Organization emptyOrganization = organizationRepository.save(new Organization(
                "Dashboard empty organization",
                OrganizationType.ETC,
                null,
                null
        ));
        Organization inactiveOrganization = organizationRepository.save(new Organization(
                "Dashboard inactive organization",
                OrganizationType.ETC,
                null,
                null
        ));
        inactiveOrganization.deactivate();

        EvaluationTarget activeTarget = targetRepository.save(new EvaluationTarget(
                organization,
                "Dashboard active target",
                TargetType.WEB,
                "https://active.example",
                "active"
        ));
        EvaluationTarget tieTarget = targetRepository.save(new EvaluationTarget(
                organization,
                "Dashboard tie target",
                TargetType.WEB,
                "https://tie.example",
                "tie"
        ));
        EvaluationTarget zeroIssueTarget = targetRepository.save(new EvaluationTarget(
                organization,
                "Dashboard zero issue target",
                TargetType.WEB,
                "https://zero.example",
                "zero"
        ));
        EvaluationTarget inactiveTarget = targetRepository.save(new EvaluationTarget(
                organization,
                "Dashboard inactive target",
                TargetType.WEB,
                "https://inactive.example",
                "inactive"
        ));
        inactiveTarget.deactivate();
        EvaluationTarget deletedTarget = targetRepository.save(new EvaluationTarget(
                organization,
                "Dashboard deleted target",
                TargetType.WEB,
                "https://deleted.example",
                "deleted"
        ));
        deletedTarget.markDeleted();
        EvaluationTarget inactiveOrganizationTarget = targetRepository.save(new EvaluationTarget(
                inactiveOrganization,
                "Dashboard excluded target",
                TargetType.WEB,
                "https://excluded.example",
                "excluded"
        ));

        EvaluationRequest latestCompleted = requestRepository.save(new EvaluationRequest(activeTarget, "latest by updatedAt"));
        latestCompleted.changeStatus(EvaluationRequestStatus.COMPLETED);
        EvaluationRequest previousCompleted = requestRepository.save(new EvaluationRequest(activeTarget, "newer id but older update"));
        previousCompleted.changeStatus(EvaluationRequestStatus.COMPLETED);
        EvaluationRequest pending = requestRepository.save(new EvaluationRequest(activeTarget, "pending"));
        EvaluationRequest tieOlder = requestRepository.save(new EvaluationRequest(tieTarget, "tie older id"));
        tieOlder.changeStatus(EvaluationRequestStatus.COMPLETED);
        EvaluationRequest tieNewer = requestRepository.save(new EvaluationRequest(tieTarget, "tie newer id"));
        tieNewer.changeStatus(EvaluationRequestStatus.COMPLETED);
        EvaluationRequest zeroIssue = requestRepository.save(new EvaluationRequest(zeroIssueTarget, "zero issues"));
        zeroIssue.changeStatus(EvaluationRequestStatus.COMPLETED);
        EvaluationRequest excluded = requestRepository.save(new EvaluationRequest(inactiveOrganizationTarget, "excluded"));
        excluded.changeStatus(EvaluationRequestStatus.COMPLETED);

        scoreResultRepository.save(new ScoreResult(
                latestCompleted,
                new BigDecimal("91.50"),
                new BigDecimal("92.00"),
                new BigDecimal("90.00"),
                new BigDecimal("91.00")
        ));
        scoreResultRepository.save(new ScoreResult(
                previousCompleted,
                new BigDecimal("81.00"),
                new BigDecimal("80.00"),
                new BigDecimal("82.00"),
                new BigDecimal("81.00")
        ));
        scoreResultRepository.save(new ScoreResult(
                excluded,
                new BigDecimal("10.00"),
                new BigDecimal("10.00"),
                new BigDecimal("10.00"),
                new BigDecimal("10.00")
        ));

        AnalysisResult latestRule = saveAnalysis(latestCompleted, AnalyzerType.RULE_BASED);
        AnalysisResult latestAi = saveAnalysis(latestCompleted, AnalyzerType.AI_TEXT);
        issueResultRepository.saveAll(List.of(
                issue(latestRule, "5.1.1", "대체 텍스트 누락", Severity.CRITICAL),
                issue(latestRule, "5.1.1", "대체 텍스트 누락", Severity.CRITICAL),
                issue(latestAi, "7.1.1", "텍스트 난이도", Severity.HIGH)
        ));
        AnalysisResult previousAnalysis = saveAnalysis(previousCompleted, AnalyzerType.CV_VISION);
        issueResultRepository.save(issue(previousAnalysis, "5.3.3", "색상 대비", Severity.MEDIUM));
        AnalysisResult tieOlderAnalysis = saveAnalysis(tieOlder, AnalyzerType.RULE_BASED);
        issueResultRepository.save(issue(tieOlderAnalysis, "tie-old", "Tie old", Severity.LOW));
        AnalysisResult tieNewerAnalysis = saveAnalysis(tieNewer, AnalyzerType.RULE_BASED);
        issueResultRepository.save(issue(tieNewerAnalysis, "tie-new", "Tie new", Severity.HIGH));
        AnalysisResult excludedAnalysis = saveAnalysis(excluded, AnalyzerType.RULE_BASED);
        issueResultRepository.save(issue(excludedAnalysis, "excluded", "excluded", Severity.CRITICAL));

        entityManager.flush();
        LocalDateTime baseTime = LocalDateTime.of(2026, 8, 23, 10, 0);
        setUpdatedAt(previousCompleted.getId(), baseTime);
        setUpdatedAt(latestCompleted.getId(), baseTime.plusMinutes(1));
        setUpdatedAt(pending.getId(), baseTime.plusMinutes(2));
        setUpdatedAt(tieOlder.getId(), baseTime.plusMinutes(3));
        setUpdatedAt(tieNewer.getId(), baseTime.plusMinutes(3));
        setUpdatedAt(zeroIssue.getId(), baseTime.plusMinutes(4));
        entityManager.clear();

        return new ContractFixture(
                organization.getId(),
                emptyOrganization.getId(),
                inactiveOrganization.getId(),
                activeTarget.getId(),
                tieTarget.getId(),
                zeroIssueTarget.getId(),
                inactiveTarget.getId(),
                deletedTarget.getId(),
                latestCompleted.getId(),
                previousCompleted.getId(),
                pending.getId(),
                tieNewer.getId(),
                zeroIssue.getId(),
                excluded.getId()
        );
    }

    private void createScaleFixtures(String prefix, int count) {
        for (int index = 0; index < count; index++) {
            EvaluationRequest request = createRequest(prefix + "-" + index, true);
            scoreResultRepository.save(new ScoreResult(
                    request,
                    new BigDecimal("88.00"),
                    new BigDecimal("87.00"),
                    new BigDecimal("89.00"),
                    new BigDecimal("88.00")
            ));
            addAnalysisWithIssue(request, AnalyzerType.RULE_BASED, "scale-" + index, Severity.LOW);
        }
    }

    private EvaluationRequest createRequest(String suffix, boolean completed) {
        Organization organization = organizationRepository.save(new Organization(
                "Query count " + suffix,
                OrganizationType.ETC,
                null,
                null
        ));
        EvaluationTarget target = targetRepository.save(new EvaluationTarget(
                organization,
                "Query count target " + suffix,
                TargetType.WEB,
                "https://" + suffix + ".example",
                null
        ));
        EvaluationRequest request = requestRepository.save(new EvaluationRequest(target, suffix));
        if (completed) {
            request.changeStatus(EvaluationRequestStatus.COMPLETED);
        }
        return request;
    }

    private void addAnalysisWithIssue(
            EvaluationRequest request,
            AnalyzerType analyzerType,
            String issueCode,
            Severity severity
    ) {
        AnalysisResult analysis = saveAnalysis(request, analyzerType);
        issueResultRepository.save(issue(analysis, issueCode, "Issue " + issueCode, severity));
    }

    private AnalysisResult saveAnalysis(EvaluationRequest request, AnalyzerType analyzerType) {
        LocalDateTime timestamp = LocalDateTime.of(2026, 8, 23, 12, 0);
        return analysisResultRepository.save(new AnalysisResult(
                request,
                analyzerType,
                AnalysisStatus.SUCCESS,
                "summary",
                timestamp,
                timestamp.plusSeconds(1)
        ));
    }

    private IssueResult issue(
            AnalysisResult analysis,
            String code,
            String title,
            Severity severity
    ) {
        return new IssueResult(
                analysis,
                code,
                title,
                severity,
                "main > #target",
                "FULL DETAIL MUST NOT LEAK"
        );
    }

    private JsonNode overviewData() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/dashboard/overview"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andReturn();
        return objectMapper.readTree(result.getResponse().getContentAsByteArray()).path("data");
    }

    private long overviewQueryCount() throws Exception {
        Statistics statistics = prepareStatistics();
        mockMvc.perform(get("/api/dashboard/overview"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true));
        return statistics.getPrepareStatementCount();
    }

    private long issueDetailQueryCount(Long requestId, int expectedIssueCount) throws Exception {
        Statistics statistics = prepareStatistics();
        mockMvc.perform(get("/api/results/requests/{requestId}/issues", requestId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(expectedIssueCount));
        return statistics.getPrepareStatementCount();
    }

    private long resultSummaryQueryCount(
            Long requestId,
            int expectedIssueCount,
            int expectedCriticalIssueCount
    ) throws Exception {
        Statistics statistics = prepareStatistics();
        mockMvc.perform(get("/api/results/requests/{requestId}/summary", requestId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.totalIssueCount").value(expectedIssueCount))
                .andExpect(jsonPath("$.data.criticalIssueCount").value(expectedCriticalIssueCount));
        return statistics.getPrepareStatementCount();
    }

    private Statistics prepareStatistics() {
        entityManager.flush();
        entityManager.clear();
        Statistics statistics = entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
        statistics.clear();
        return statistics;
    }

    private void setUpdatedAt(Long requestId, LocalDateTime updatedAt) {
        jdbcTemplate.update(
                "update evaluation_request set updated_at = ? where id = ?",
                Timestamp.valueOf(updatedAt),
                requestId
        );
    }

    private JsonNode findById(JsonNode array, long id) {
        return findById(array, "id", id);
    }

    private JsonNode findById(JsonNode array, String field, long id) {
        return StreamSupport.stream(array.spliterator(), false)
                .filter(node -> node.path(field).asLong() == id)
                .findFirst()
                .orElse(null);
    }

    private List<String> fieldNames(JsonNode node) {
        List<String> names = new ArrayList<>();
        node.fieldNames().forEachRemaining(names::add);
        return names;
    }

    private record ContractFixture(
            long organizationId,
            long emptyOrganizationId,
            long inactiveOrganizationId,
            long activeTargetId,
            long tieTargetId,
            long zeroIssueTargetId,
            long inactiveTargetId,
            long deletedTargetId,
            long latestCompletedRequestId,
            long previousCompletedRequestId,
            long pendingRequestId,
            long tieNewerRequestId,
            long zeroIssueRequestId,
            long excludedRequestId
    ) {
    }
}
