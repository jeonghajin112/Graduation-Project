package com.accessibility.platform.integration.service;

import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.result.dto.EvaluationIssueResponse;
import com.accessibility.platform.result.service.EvaluationResultQueryService;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@SpringBootTest
@Transactional
class AiEvaluationIngestionLocatorIntegrationTest {

    @Autowired
    AiEvaluationIngestionService ingestionService;

    @Autowired
    EvaluationResultQueryService resultQueryService;

    @Autowired
    EvaluationCaptureMetadataRepository captureMetadataRepository;

    @Autowired
    LegacyIssueStandardMigrationRunner legacyIssueStandardMigrationRunner;

    @Autowired
    OrganizationRepository organizationRepository;

    @Autowired
    EvaluationTargetRepository targetRepository;

    @Autowired
    EvaluationRequestRepository requestRepository;

    @Autowired
    ScoreResultRepository scoreResultRepository;

    @Autowired
    EntityManager entityManager;

    @Test
    void failedRequestCannotBeResurrectedByLateIngestion() {
        EvaluationRequest request = createRequest();
        request.changeStatus(EvaluationRequestStatus.FAILED);
        requestRepository.saveAndFlush(request);

        String resultJson = """
                {
                  "url":"https://example.com/late-result",
                  "request_id":%d
                }
                """.formatted(request.getId());

        assertThatThrownBy(() -> ingestionService.save(resultJson))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("terminal request")
                .hasMessageContaining("FAILED");

        assertThat(requestRepository.findById(request.getId()).orElseThrow().getStatus())
                .isEqualTo(EvaluationRequestStatus.FAILED);
        assertThat(scoreResultRepository.findByEvaluationRequestId(request.getId())).isEmpty();
    }

    @Test
    void persistsAndExposesRuleAndCvTypedLocatorsWithoutRemovingLegacySelector() {
        EvaluationRequest request = createRequest();
        String resultJson = """
                {
                  "url":"https://example.com/",
                  "request_id":%d,
                  "analyzed_at":"2026-08-11T12:00:00",
                  "capture_metadata":{
                    "requestedUrl":"https://example.com/",
                    "finalUrl":"https://example.com/final",
                    "capturedAt":"2026-08-11T11:59:00",
                    "viewportWidthCssPx":1280,
                    "viewportHeightCssPx":720,
                    "deviceScaleFactor":1.0,
                    "pageWidthCssPx":1280,
                    "pageHeightCssPx":1600
                  },
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
                               "htmlSnippet":"<button class=pay>Pay</button>",
                               "carouselContext":{"carouselId":1,"slideIndex":1,"slideCount":3}
                             }
                          }]
                        }]
                      }]
                    },
                    "text_difficulty":{
                      "meta":{"page_score":90,"flagged_count":1,"suggestion_needed":1},
                      "results":[{
                        "text":"어려운 안내 문장",
                        "category":"paragraph",
                        "selector":"p.guide",
                        "flags":["어려운 어휘 과다","위치 참조"],
                        "needs_suggestion":true,
                        "standard_issues":[
                          {
                            "type":"hard_vocab_ratio",
                            "priority":"medium",
                            "wcag":{"id":"3.1.5","name":"읽기 수준","standard":"WCAG","version":"2.2"},
                            "kwcag_items":[]
                          },
                          {
                            "type":"location_dependency",
                            "priority":"high",
                            "wcag":{"id":"1.3.3","name":"감각적 특성","standard":"WCAG","version":"2.2"},
                            "kwcag_items":[{"id":"5.3.3","name":"명확한 지시사항 제공","standard":"KWCAG","version":"2.2"}]
                          }
                        ]
                      }]
                    },
                    "text_suggestions":{"status":"failed"},
                    "cv_visual":{
                      "summary":{"pass_rate":70,"fail_count":1},
                      "kwcag_item":{"id":"5.4.3","name":"텍스트 콘텐츠의 명도 대비"},
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
        entityManager.flush();
        entityManager.clear();
        List<EvaluationIssueResponse> issues = resultQueryService.getIssues(request.getId());

        assertThat(captureMetadataRepository.findByEvaluationRequestId(request.getId())
                .orElseThrow()
                .getFinalUrl())
                .isEqualTo("https://example.com/final");

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
        assertThat(ruleIssue.locator().carouselContext()).isNotNull();
        assertThat(ruleIssue.locator().carouselContext().carouselId()).isEqualTo(1);
        assertThat(ruleIssue.locator().carouselContext().slideIndex()).isEqualTo(1);
        assertThat(ruleIssue.locator().carouselContext().slideCount()).isEqualTo(3);

        List<EvaluationIssueResponse> textIssues = issues.stream()
                .filter(issue -> issue.module().equals("text_difficulty"))
                .toList();
        assertThat(textIssues)
                .extracting(EvaluationIssueResponse::wcagCode)
                .containsExactlyInAnyOrder("WCAG 3.1.5", "5.3.3");
        assertThat(textIssues)
                .filteredOn(issue -> issue.wcagCode().equals("5.3.3"))
                .singleElement()
                .extracting(EvaluationIssueResponse::title)
                .isEqualTo("명확한 지시사항 제공");

        EvaluationIssueResponse cvIssue = issues.stream()
                .filter(issue -> issue.module().equals("cv_visual"))
                .findFirst()
                .orElseThrow();
        assertThat(cvIssue.selector()).isEqualTo("x=100, y=200, width=80, height=24");
        assertThat(cvIssue.locator().kind()).isEqualTo("BOUNDING_BOX");
        assertThat(cvIssue.locator().coordinateSpace()).isEqualTo("SCREENSHOT_PX");
        assertThat(cvIssue.locator().width()).isEqualTo(80.0);
        assertThat(cvIssue.wcagCode()).isEqualTo("5.4.3");
    }

    @Test
    void migratesLegacyTextFlagsAndCvCodeWithoutCollapsingDifferentStandards() {
        EvaluationRequest request = createRequest();
        // The CV entry deliberately reproduces the former 5.3.3 misclassification so
        // this test can prove that the startup migration corrects it to KWCAG 5.4.3.
        String resultJson = """
                {
                  "url":"https://example.com/legacy",
                  "request_id":%d,
                  "analyzed_at":"2026-08-11T12:00:00",
                  "total_score":75,
                  "score_breakdown":{"module_scores":{"rule_based":100,"difficulty":50,"cv":75}},
                  "modules":{
                    "rule_based":{"summary":{"total_violations":0,"total_passes":1},"violations":[]},
                    "text_difficulty":{
                      "meta":{"page_score":50,"flagged_count":1,"suggestion_needed":1},
                      "results":[{
                        "text":"복잡한 링크 안내",
                        "category":"link",
                        "selector":"a.legacy",
                        "flags":["어려운 어휘 과다","위치 참조","link 텍스트 길이 과다"],
                        "needs_suggestion":true
                      }]
                    },
                    "text_suggestions":{"status":"failed"},
                    "cv_visual":{
                      "summary":{"pass_rate":75,"fail_count":1},
                      "kwcag_item":{"id":"5.3.3","name":"콘텐츠의 명도 대비"},
                      "violations":[{
                        "text":"Legacy contrast","contrast_ratio":2,"required_ratio":4.5,
                        "location":{"x":1,"y":2,"width":3,"height":4}
                      }]
                    }
                  }
                }
                """.formatted(request.getId());

        ingestionService.save(resultJson);
        assertThat(resultQueryService.getIssues(request.getId()))
                .extracting(EvaluationIssueResponse::wcagCode)
                .containsExactlyInAnyOrder("TEXT_DIFFICULTY", "5.3.3");

        legacyIssueStandardMigrationRunner.run(new DefaultApplicationArguments(new String[0]));

        assertThat(resultQueryService.getIssues(request.getId()))
                .extracting(EvaluationIssueResponse::wcagCode)
                .containsExactlyInAnyOrder("WCAG 3.1.5", "5.3.3", "6.4.3", "5.4.3");
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
}
