package com.accessibility.platform.capturemetadata;

import com.accessibility.platform.capturemetadata.exception.CaptureMetadataValidationException;
import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.integration.service.AiEvaluationIngestionService;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class EvaluationCaptureMetadataIntegrationTest {

    @Autowired
    AiEvaluationIngestionService ingestionService;

    @Autowired
    EvaluationCaptureMetadataRepository metadataRepository;

    @Autowired
    OrganizationRepository organizationRepository;

    @Autowired
    EvaluationTargetRepository targetRepository;

    @Autowired
    EvaluationRequestRepository requestRepository;

    @Autowired
    ScoreResultRepository scoreResultRepository;

    @Autowired
    MockMvc mockMvc;

    @Test
    void ingestsCaptureMetadataAtomicallyAndExposesOnlyTheLiveAlignmentContract() throws Exception {
        EvaluationRequest request = createRequest(
                "Capture metadata response",
                "https://example.com/requested"
        );

        ingestionService.save(resultJson(
                request.getId(),
                "https://example.com/requested",
                "https://www.example.com/final",
                1280,
                720,
                1280,
                2400,
                1.25
        ));

        assertThat(metadataRepository.findByEvaluationRequestId(request.getId()))
                .get()
                .satisfies(metadata -> {
                    assertThat(metadata.getFinalUrl()).isEqualTo("https://www.example.com/final");
                    assertThat(metadata.getViewportWidthCssPx()).isEqualTo(1280);
                    assertThat(metadata.getPageHeightCssPx()).isEqualTo(2400);
                });

        mockMvc.perform(get("/api/results/requests/{requestId}/capture-metadata", request.getId())
                        .accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.requestId").value(request.getId()))
                .andExpect(jsonPath("$.data.requestedUrl").value("https://example.com/requested"))
                .andExpect(jsonPath("$.data.finalUrl").value("https://www.example.com/final"))
                .andExpect(jsonPath("$.data.capturedAt").value("2026-09-03T10:15:30"))
                .andExpect(jsonPath("$.data.viewportWidthCssPx").value(1280))
                .andExpect(jsonPath("$.data.viewportHeightCssPx").value(720))
                .andExpect(jsonPath("$.data.deviceScaleFactor").value(1.25))
                .andExpect(jsonPath("$.data.pageWidthCssPx").value(1280))
                .andExpect(jsonPath("$.data.pageHeightCssPx").value(2400))
                .andExpect(jsonPath("$.data.contentUrl").doesNotExist())
                .andExpect(jsonPath("$.data.contentType").doesNotExist())
                .andExpect(jsonPath("$.data.sizeBytes").doesNotExist())
                .andExpect(jsonPath("$.data.sha256").doesNotExist())
                .andExpect(jsonPath("$.data.captureMode").doesNotExist());
    }

    @Test
    void invalidCaptureMetadataRollsBackResultsAndLeavesTheRequestPending() {
        EvaluationRequest request = createRequest(
                "Invalid capture metadata",
                "https://example.com/invalid"
        );

        assertThatThrownBy(() -> ingestionService.save(resultJson(
                request.getId(),
                "https://example.com/invalid",
                "https://example.com/final",
                1280,
                720,
                1200,
                700,
                1.0
        )))
                .isInstanceOf(CaptureMetadataValidationException.class)
                .hasMessageContaining("Page dimensions");

        assertThat(metadataRepository.findByEvaluationRequestId(request.getId())).isEmpty();
        assertThat(scoreResultRepository.findByEvaluationRequestId(request.getId())).isEmpty();
        assertThat(requestRepository.findById(request.getId()).orElseThrow().getStatus())
                .isEqualTo(EvaluationRequestStatus.PENDING);
    }

    @Test
    void acceptsEquivalentDefaultPortsAndTrailingSlashes() {
        EvaluationRequest request = createRequest(
                "Equivalent capture URLs",
                "https://EXAMPLE.com:443/requested/"
        );

        ingestionService.save(resultJson(
                request.getId(),
                "https://example.com/requested",
                "https://example.com:443/requested/",
                "https://www.example.com:443/final/",
                "https://WWW.EXAMPLE.com/final",
                1280,
                720,
                1280,
                2400,
                1.0
        ));

        assertThat(metadataRepository.findByEvaluationRequestId(request.getId()))
                .get()
                .extracting(metadata -> metadata.getFinalUrl())
                .isEqualTo("https://www.example.com:443/final/");
    }

    @Test
    void ingestsFragmentFreeFinalUrlWhenRuleAnalyzerObservedTheSameNavigationWithAFragment() {
        EvaluationRequest request = createRequest(
                "Fragment-free live URL",
                "https://example.com/requested"
        );

        ingestionService.save(resultJson(
                request.getId(),
                "https://example.com/requested",
                "https://example.com/requested",
                "https://www.example.com/final?mode=a",
                "https://WWW.EXAMPLE.com:443/final?mode=a#results",
                1280,
                720,
                1280,
                2400,
                1.0
        ));

        assertThat(metadataRepository.findByEvaluationRequestId(request.getId()))
                .get()
                .extracting(metadata -> metadata.getFinalUrl())
                .isEqualTo("https://www.example.com/final?mode=a");
    }

    @Test
    void rejectsDifferentWwwOriginBetweenCaptureAndRuleObservation() {
        EvaluationRequest request = createRequest(
                "Different final origin",
                "https://example.com/requested"
        );

        assertThatThrownBy(() -> ingestionService.save(resultJson(
                request.getId(),
                "https://example.com/requested",
                "https://example.com/requested",
                "https://www.example.com/final",
                "https://example.com/final",
                1280,
                720,
                1280,
                2400,
                1.0
        )))
                .isInstanceOf(CaptureMetadataValidationException.class)
                .hasMessageContaining("finalUrl must match");
    }

    @Test
    void removedArtifactEndpointReturnsNotFoundInsteadOfServerError() throws Exception {
        mockMvc.perform(get("/api/results/requests/321/artifact")
                        .accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.success").value(false));
    }

    @Test
    void rejectsFinalUrlsThatTheLiveSessionPolicyCannotLaunch() {
        String[] unsafeFinalUrls = {
                "http://example.com/final",
                "https://user:secret@example.com/final",
                "https://example.com:444/final",
                "https://example.com/final#section"
        };

        for (int index = 0; index < unsafeFinalUrls.length; index++) {
            String unsafeFinalUrl = unsafeFinalUrls[index];
            String requestedUrl = "https://example.com/unsafe-final-" + index;
            EvaluationRequest request = createRequest(
                    "Unsafe final URL " + index,
                    requestedUrl
            );

            assertThatThrownBy(() -> ingestionService.save(resultJson(
                    request.getId(),
                    requestedUrl,
                    unsafeFinalUrl,
                    1280,
                    720,
                    1280,
                    2400,
                    1.0
            )))
                    .isInstanceOf(CaptureMetadataValidationException.class)
                    .hasMessageContaining("finalUrl must use HTTPS");

            assertThat(metadataRepository.findByEvaluationRequestId(request.getId())).isEmpty();
            assertThat(scoreResultRepository.findByEvaluationRequestId(request.getId())).isEmpty();
            assertThat(requestRepository.findById(request.getId()).orElseThrow().getStatus())
                    .isEqualTo(EvaluationRequestStatus.PENDING);
        }
    }

    @Test
    void rejectsCaptureRequestedUrlThatChangesTheRequestTargetOrResultUrl() {
        EvaluationRequest targetMismatch = createRequest(
                "Capture target mismatch",
                "https://example.com/expected?mode=one"
        );
        assertThatThrownBy(() -> ingestionService.save(resultJson(
                targetMismatch.getId(),
                "https://example.com/expected?mode=two",
                "https://example.com/final",
                1280,
                720,
                1280,
                2400,
                1.0
        )))
                .isInstanceOf(CaptureMetadataValidationException.class)
                .hasMessageContaining("evaluation request target URL");

        EvaluationRequest resultMismatch = createRequest(
                "Capture result mismatch",
                "https://example.org/expected"
        );
        assertThatThrownBy(() -> ingestionService.save(resultJson(
                resultMismatch.getId(),
                "https://other.example/expected",
                "https://example.org/expected",
                "https://example.org/final",
                null,
                1280,
                720,
                1280,
                2400,
                1.0
        )))
                .isInstanceOf(CaptureMetadataValidationException.class)
                .hasMessageContaining("result.url");
    }

    @Test
    void rejectsCapturedFinalUrlThatDiffersFromRuleAnalyzerUrl() {
        String requestedUrl = "https://example.com/rule-final";
        EvaluationRequest request = createRequest("Rule final mismatch", requestedUrl);

        assertThatThrownBy(() -> ingestionService.save(resultJson(
                request.getId(),
                requestedUrl,
                requestedUrl,
                "https://example.com/analyzed",
                "https://example.com/different?version=2",
                1280,
                720,
                1280,
                2400,
                1.0
        )))
                .isInstanceOf(CaptureMetadataValidationException.class)
                .hasMessageContaining("modules.rule_based.metadata.url");
    }

    @Test
    void returnsNotFoundWhenARequestHasNoCaptureMetadata() throws Exception {
        EvaluationRequest request = createRequest(
                "Missing capture metadata",
                "https://example.com/no-capture"
        );

        mockMvc.perform(get("/api/results/requests/{requestId}/capture-metadata", request.getId()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.success").value(false));
    }

    private EvaluationRequest createRequest(String name, String url) {
        Organization organization = organizationRepository.save(new Organization(
                name,
                OrganizationType.ETC,
                null,
                null
        ));
        EvaluationTarget target = targetRepository.save(new EvaluationTarget(
                organization,
                name,
                TargetType.WEB,
                url,
                null,
                null
        ));
        return requestRepository.save(new EvaluationRequest(target, name));
    }

    private String resultJson(
            Long requestId,
            String requestedUrl,
            String finalUrl,
            int viewportWidth,
            int viewportHeight,
            int pageWidth,
            int pageHeight,
            double deviceScaleFactor
    ) {
        return resultJson(
                requestId,
                requestedUrl,
                requestedUrl,
                finalUrl,
                null,
                viewportWidth,
                viewportHeight,
                pageWidth,
                pageHeight,
                deviceScaleFactor
        );
    }

    private String resultJson(
            Long requestId,
            String resultUrl,
            String requestedUrl,
            String finalUrl,
            String ruleAnalyzedUrl,
            int viewportWidth,
            int viewportHeight,
            int pageWidth,
            int pageHeight,
            double deviceScaleFactor
    ) {
        String modules = ruleAnalyzedUrl == null
                ? "{}"
                : "{\"rule_based\":{\"metadata\":{\"url\":\"" + ruleAnalyzedUrl + "\"}}}";
        return """
                {
                  "url":"%s",
                  "request_id":%d,
                  "analyzed_at":"2026-09-03T10:15:30",
                  "capture_metadata":{
                    "requestedUrl":"%s",
                    "finalUrl":"%s",
                    "capturedAt":"2026-09-03T10:15:30",
                    "viewportWidthCssPx":%d,
                    "viewportHeightCssPx":%d,
                    "deviceScaleFactor":%s,
                    "pageWidthCssPx":%d,
                    "pageHeightCssPx":%d,
                    "captureMode":"DOM_REPLAY"
                  },
                  "total_score":80,
                  "score_breakdown":{"module_scores":{"rule_based":80,"difficulty":80,"cv":80}},
                  "modules":%s
                }
                """.formatted(
                resultUrl,
                requestId,
                requestedUrl,
                finalUrl,
                viewportWidth,
                viewportHeight,
                deviceScaleFactor,
                pageWidth,
                pageHeight,
                modules
        );
    }
}
