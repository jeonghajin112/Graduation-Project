package com.accessibility.platform.integration.service;

import com.accessibility.platform.artifact.domain.CaptureMode;
import com.accessibility.platform.artifact.dto.EvaluationArtifactMetadataRequest;
import com.accessibility.platform.artifact.repository.EvaluationArtifactRepository;
import com.accessibility.platform.artifact.service.EvaluationArtifactService;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.result.dto.EvaluationIssueResponse;
import com.accessibility.platform.result.service.EvaluationResultQueryService;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.time.LocalDateTime;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@Transactional
class AiEvaluationIngestionLocatorIntegrationTest {

    @Autowired
    AiEvaluationIngestionService ingestionService;

    @Autowired
    EvaluationResultQueryService resultQueryService;

    @Autowired
    EvaluationArtifactService artifactService;

    @Autowired
    EvaluationArtifactRepository artifactRepository;

    @Autowired
    OrganizationRepository organizationRepository;

    @Autowired
    EvaluationTargetRepository targetRepository;

    @Autowired
    EvaluationRequestRepository requestRepository;

    @Test
    void persistsAndExposesRuleAndCvTypedLocatorsWithoutRemovingLegacySelector() {
        EvaluationRequest request = createRequest();
        artifactService.replace(
                request.getId(),
                artifactMetadata(),
                new MockMultipartFile(
                        "document",
                        "page.html",
                        "text/html;charset=utf-8",
                        "<html><body><button class=pay>Old replay</button></body></html>".getBytes(StandardCharsets.UTF_8)
                )
        );
        assertThat(artifactRepository.findByEvaluationRequestId(request.getId())).isPresent();
        String resultJson = """
                {
                  "url":"https://example.com/",
                  "request_id":%d,
                  "analyzed_at":"2026-08-11T12:00:00",
                  "total_score":81.5,
                  "score_breakdown":{"module_scores":{"rule_based":80,"difficulty":90,"cv":70}},
                  "modules":{
                    "rule_based":{
                      "summary":{"total_violations":1,"total_passes":10},
                      "violations":[{
                        "kwcag_id":"5.1.1",
                        "kwcag_name":"Alternative text",
                        "severity":"critical",
                        "rules":[{
                          "help":"Add alternative text",
                          "nodes":[{
                            "selector":"button.pay",
                            "html":"<button class=pay>Pay</button>",
                            "failure_summary":"Missing accessible name",
                            "locator":{
                              "kind":"DOM_RECT",
                              "pathSteps":[{"context":"document","selector":"button.pay","frameUrl":null}],
                              "x":20,"y":30,"width":120,"height":40,
                              "coordinateSpace":"DOCUMENT_CSS_PX",
                              "visible":true,
                              "htmlSnippet":"<button class=pay>Pay</button>"
                            }
                          }]
                        }]
                      }]
                    },
                    "text_difficulty":{"meta":{"page_score":90,"flagged_count":0,"suggestion_needed":0},"results":[]},
                    "text_suggestions":{"results":[]},
                    "cv_visual":{
                      "summary":{"pass_rate":70,"fail_count":1},
                      "kwcag_item":{"id":"5.3.3","name":"Contrast"},
                      "violations":[{
                        "text":"Checkout",
                        "contrast_ratio":2.0,
                        "required_ratio":4.5,
                        "contrast_display":"2.0:1",
                        "location":{"x":100,"y":200,"width":80,"height":24}
                      }]
                    }
                  }
                }
                """.formatted(request.getId());

        ingestionService.save(resultJson);
        List<EvaluationIssueResponse> issues = resultQueryService.getIssues(request.getId());

        assertThat(artifactRepository.findByEvaluationRequestId(request.getId()))
                .as("rerun ingestion must not leave stale visual evidence")
                .isEmpty();

        EvaluationIssueResponse ruleIssue = issues.stream()
                .filter(issue -> issue.module().equals("rule_based"))
                .findFirst()
                .orElseThrow();
        assertThat(ruleIssue.selector()).isEqualTo("button.pay");
        assertThat(ruleIssue.locator().kind()).isEqualTo("DOM_RECT");
        assertThat(ruleIssue.locator().pathSteps()).hasSize(1);
        assertThat(ruleIssue.locator().pathSteps().getFirst().selector()).isEqualTo("button.pay");
        assertThat(ruleIssue.locator().x()).isEqualTo(20.0);
        assertThat(ruleIssue.locator().htmlSnippet()).contains("button");

        EvaluationIssueResponse cvIssue = issues.stream()
                .filter(issue -> issue.module().equals("cv_visual"))
                .findFirst()
                .orElseThrow();
        assertThat(cvIssue.selector()).isEqualTo("x=100, y=200, width=80, height=24");
        assertThat(cvIssue.locator().kind()).isEqualTo("BOUNDING_BOX");
        assertThat(cvIssue.locator().coordinateSpace()).isEqualTo("SCREENSHOT_PX");
        assertThat(cvIssue.locator().width()).isEqualTo(80.0);
    }

    private EvaluationRequest createRequest() {
        Organization organization = organizationRepository.save(new Organization(
                "Locator ingestion test",
                OrganizationType.ETC,
                "https://example.com/",
                null
        ));
        EvaluationTarget target = targetRepository.save(new EvaluationTarget(
                organization,
                "Example",
                TargetType.WEB,
                "https://example.com/",
                null,
                "https://example.com/favicon.ico"
        ));
        return requestRepository.save(new EvaluationRequest(target, "locator ingestion test"));
    }

    private EvaluationArtifactMetadataRequest artifactMetadata() {
        return new EvaluationArtifactMetadataRequest(
                "https://example.com/",
                "https://example.com/",
                LocalDateTime.of(2026, 8, 11, 11, 59),
                2,
                2,
                1.0,
                2,
                2,
                CaptureMode.DOM_REPLAY
        );
    }
}
