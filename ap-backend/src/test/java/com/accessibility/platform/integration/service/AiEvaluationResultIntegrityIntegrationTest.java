package com.accessibility.platform.integration.service;

import com.accessibility.platform.analysis.domain.AnalyzerType;
import com.accessibility.platform.analysis.repository.AnalysisResultRepository;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.result.service.EvaluationResultQueryService;
import com.accessibility.platform.score.domain.CvScoreStatus;
import com.accessibility.platform.score.repository.ScoreDetailRepository;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
class AiEvaluationResultIntegrityIntegrationTest {
    @Autowired AiEvaluationIngestionService ingestion;
    @Autowired OrganizationRepository organizations;
    @Autowired EvaluationTargetRepository targets;
    @Autowired EvaluationRequestRepository requests;
    @Autowired ScoreResultRepository scores;
    @Autowired ScoreDetailRepository details;
    @Autowired AnalysisResultRepository analyses;
    @Autowired EvaluationResultQueryService results;
    @Autowired EntityManager entityManager;
    @Autowired MockMvc mvc;
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void storesUnmappedRuleNodesWithTheirOriginalRuleIdSeverityAndLocation() throws Exception {
        var request = createRequest();
        ObjectNode payload = basePayload(request, 99);
        // The producer's actual meta-viewport fixture is exercised by artifact.test.js.
        payload.withObject("modules").set("rule_based", json.readTree("""
                {"violations":[],"unmapped_violations":[{
                  "axe_rule_id":"meta-viewport","description":"Zoom is disabled",
                  "help":"Zooming and scaling must not be disabled","impact":"moderate",
                  "node_count":1,"nodes":[{
                    "selector":"meta[name=viewport]","html":"<meta name=viewport content=user-scalable=no>",
                    "impact":"moderate","failure_summary":"user-scalable=no prevents zoom",
                    "locator":{"pathSteps":[{"context":"DOCUMENT","selector":"meta[name=viewport]"}],
                      "visible":false,"rect":{"x":0,"y":0,"width":0,"height":0},
                      "coordinateSpace":"DOCUMENT_CSS_PX"}
                  }]
                }]}
                """));
        ingestion.save(payload.toString());
        entityManager.flush();
        entityManager.clear();
        assertThat(results.getSummary(request.getId()).totalScore()).isEqualByComparingTo("99");
        var issues = results.getIssues(request.getId());
        assertThat(issues).hasSize(1);
        var issue = issues.getFirst();
        assertThat(issue.module()).isEqualTo("rule_based");
        assertThat(issue.wcagCode()).isEqualTo("meta-viewport");
        assertThat(issue.severity()).isEqualTo("MODERATE");
        assertThat(issue.selector()).isEqualTo("meta[name=viewport]");
        assertThat(issue.locator().pathSteps().getFirst().selector()).isEqualTo(issue.selector());
        assertThat(issue.locator().htmlSnippet()).contains("user-scalable=no");
        assertThat(issue.locator().x()).isZero();
        assertThat(issue.locator().visible()).isFalse();
        assertThat(issue.description()).contains("Zoom is disabled", "prevents zoom");
    }

    @Test
    void keepsMappedAndUnmappedCountsSeparateAndAcceptsLegacyEvidenceGaps() throws Exception {
        var request = createRequest();
        ObjectNode payload = basePayload(request, 90);
        payload.withObject("modules").set("rule_based", json.readTree("""
                {"violations":[{"kwcag_id":"5.1.1","kwcag_name":"Alternative text","severity":"critical",
                  "rules":[{"axe_rule_id":"image-alt","nodes":[{"selector":"#image","html":"<img id=image>"}]}]}],
                 "unmapped_violations":[
                  {"axe_rule_id":"valid-lang","impact":"serious","description":"Invalid language",
                   "nodes":[{"selector":"#text","impact":"minor"}]},
                  {"axe_rule_id":"autocomplete-valid","impact":"serious","description":"Invalid autocomplete","node_count":2}
                 ]}
                """));
        ingestion.save(payload.toString());
        var issues = results.getIssues(request.getId());
        assertThat(issues).hasSize(3);
        assertThat(issues).extracting(issue -> issue.wcagCode())
                .containsExactly("5.1.1", "valid-lang", "autocomplete-valid");
        assertThat(issues).extracting(issue -> issue.severity())
                .containsExactly("CRITICAL", "MINOR", "SERIOUS");
        var legacy = issues.getLast();
        assertThat(legacy.selector()).isNull();
        assertThat(legacy.locator()).isNull();
        assertThat(legacy.description()).contains("reported_nodes=2", "위치 정보가 없습니다");
    }

    @ParameterizedTest
    @CsvSource({"NOT_MEASURED,100", "FAILED,100", "SUCCESS,80"})
    void preservesUnmeasuredFailedAndTrueZeroScoresThroughPersistenceAndHttp(String state, int total) throws Exception {
        var request = createRequest();
        var payload = basePayload(request, total);
        payload.withObject("score_breakdown").withObject("module_scores").put("rule_based", 100);
        ObjectNode module = payload.withObject("modules").putObject("cv_visual");
        module.putArray("violations");
        switch (state) {
            case "NOT_MEASURED" -> {
                module.put("status", "not_measured").put("reason", "NO_TEXT_DETECTED");
                module.putObject("summary").put("total_texts_analyzed", 0).putNull("pass_rate");
            }
            case "FAILED" -> module.put("status", "failed").put("message", "OCR process failed");
            case "SUCCESS" -> {
                module.putObject("summary").put("total_texts_analyzed", 2).put("pass_rate", 0);
                payload.withObject("score_breakdown").withObject("module_scores").put("cv", 0);
            }
            default -> throw new AssertionError(state);
        }
        ingestion.save(payload.toString());
        entityManager.flush();
        entityManager.clear();
        var savedScore = scores.findByEvaluationRequestId(request.getId()).orElseThrow();
        assertThat(savedScore.getCvStatus()).isEqualTo(CvScoreStatus.valueOf(state));
        var cvDetails = details.findByScoreResultId(savedScore.getId()).stream()
                .filter(detail -> detail.getCategory().equals("cv")).toList();
        if (state.equals("SUCCESS")) {
            assertThat(savedScore.getCvScore()).isEqualByComparingTo("0");
            assertThat(cvDetails).hasSize(1);
            assertThat(cvDetails.getFirst().getScore()).isEqualByComparingTo("0");
        } else {
            assertThat(savedScore.getCvScore()).isNull();
            assertThat(cvDetails).isEmpty();
        }
        if (state.equals("NOT_MEASURED")) {
            assertThat(analyses.findByEvaluationRequestId(request.getId())).anySatisfy(analysis -> {
                assertThat(analysis.getAnalyzerType()).isEqualTo(AnalyzerType.CV_VISION);
                assertThat(analysis.getSummary()).contains("not_measured", "NO_TEXT_DETECTED");
            });
        }
        JsonNode overview = json.readTree(mvc.perform(get("/api/dashboard/overview"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        JsonNode score = null;
        for (JsonNode candidate : overview.path("data").path("scoreResults")) {
            if (candidate.path("evaluationRequestId").asLong() == request.getId()) score = candidate;
        }
        assertThat(score).isNotNull();
        assertThat(score.path("cvStatus").asText()).isEqualTo(state);
        assertThat(score.path("cvScore").isNull()).isEqualTo(!state.equals("SUCCESS"));
        if (state.equals("SUCCESS")) assertThat(score.path("cvScore").asDouble()).isZero();
        assertThat(score.path("totalScore").asInt()).isEqualTo(total);
    }

    @Test
    void recognizesLegacyZeroSamplePayloadWithoutCreatingAZeroScoreDetail() throws Exception {
        var request = createRequest();
        var payload = basePayload(request, 100);
        payload.withObject("score_breakdown").withObject("module_scores").put("cv", 0);
        payload.withObject("modules").set("cv_visual", json.readTree("""
                {"summary":{"total_texts_analyzed":0,"pass_rate":0},"violations":[]}
                """));
        ingestion.save(payload.toString());
        var score = scores.findByEvaluationRequestId(request.getId()).orElseThrow();
        assertThat(score.getCvScore()).isNull();
        assertThat(score.getCvStatus()).isEqualTo(CvScoreStatus.NOT_MEASURED);
        assertThat(details.findByScoreResultId(score.getId())).noneMatch(detail -> detail.getCategory().equals("cv"));
    }

    private ObjectNode basePayload(EvaluationRequest request, int total) {
        var payload = json.createObjectNode();
        payload.put("url", "https://example.test/").put("request_id", request.getId()).put("total_score", total);
        payload.putObject("score_breakdown").putObject("module_scores").put("rule_based", total).put("difficulty", 100);
        payload.putObject("modules");
        return payload;
    }

    private EvaluationRequest createRequest() {
        var organization = organizations.save(new Organization("Result integrity", OrganizationType.ETC, null, null));
        var target = targets.save(new EvaluationTarget(organization, "Fixture", TargetType.WEB, "https://example.test/", null, null));
        return requests.save(new EvaluationRequest(target, "Result integrity fixture"));
    }
}
