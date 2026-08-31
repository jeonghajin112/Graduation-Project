package com.accessibility.platform.artifact.service;

import com.accessibility.platform.artifact.domain.CaptureMode;
import com.accessibility.platform.artifact.domain.EvaluationArtifact;
import com.accessibility.platform.artifact.dto.EvaluationArtifactMetadataRequest;
import com.accessibility.platform.artifact.dto.EvaluationArtifactResponse;
import com.accessibility.platform.artifact.exception.ArtifactValidationException;
import com.accessibility.platform.artifact.repository.EvaluationArtifactRepository;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.util.HexFormat;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class EvaluationArtifactServiceIntegrationTest {

    @Autowired
    EvaluationArtifactService artifactService;

    @Autowired
    MockMvc mockMvc;

    @Autowired
    ArtifactFileStorage fileStorage;

    @Autowired
    ReplayDocumentSanitizer sanitizer;

    @Autowired
    EvaluationArtifactRepository artifactRepository;

    @Autowired
    EvaluationRequestRepository requestRepository;

    @Autowired
    EvaluationTargetRepository targetRepository;

    @Autowired
    OrganizationRepository organizationRepository;

    @AfterEach
    void cleanUp() {
        artifactRepository.findAll().forEach(artifact -> fileStorage.deleteQuietly(artifact.getStorageKey()));
        artifactRepository.deleteAll();
        requestRepository.deleteAll();
        targetRepository.deleteAll();
        organizationRepository.deleteAll();
    }

    @Test
    void storesReadsAndAtomicallyReplacesOneReplayPerRequest() throws Exception {
        EvaluationRequest request = createRequest();
        EvaluationArtifactResponse first = artifactService.replace(
                request.getId(),
                metadata(),
                document("<main id=\"first\" onclick=\"bad()\">First</main><script>bad()</script>")
        );
        EvaluationArtifact firstEntity = artifactRepository.findByEvaluationRequestId(request.getId()).orElseThrow();
        String oldStorageKey = firstEntity.getStorageKey();

        String firstReplay = artifactService.getContent(first.id()).resource().getContentAsString(StandardCharsets.UTF_8);
        assertThat(first.contentUrl()).isEqualTo("/results/artifacts/" + first.id() + "/content");
        assertThat(first.contentType()).isEqualTo("text/html");
        assertThat(firstReplay).contains("id=\"first\"", "accessibility-page-replay");
        assertThat(firstReplay).doesNotContain("onclick=", "bad()");

        EvaluationArtifactResponse replacement = artifactService.replace(
                request.getId(),
                metadata(),
                document("<main id=\"replacement\">Replacement</main>")
        );

        assertThat(replacement.id()).isEqualTo(first.id());
        assertThat(artifactRepository.findAll()).hasSize(1);
        assertThat(artifactService.getContent(replacement.id()).resource().getContentAsString(StandardCharsets.UTF_8))
                .contains("id=\"replacement\"")
                .doesNotContain("id=\"first\"");
        assertThatThrownBy(() -> fileStorage.load(oldStorageKey))
                .isInstanceOf(ArtifactFileStorage.ArtifactContentNotFoundException.class);
    }

    @Test
    void refreshesAStoredLegacyBridgeBeforeItCanBeServedAfterRestart() throws Exception {
        EvaluationRequest request = createRequest();
        EvaluationArtifactResponse saved = artifactService.replace(
                request.getId(), metadata(), document("<main id=\"target\">Replay</main>")
        );
        EvaluationArtifact artifact = artifactRepository.findById(saved.id()).orElseThrow();
        String currentStorageKey = artifact.getStorageKey();
        Path currentPath = fileStorage.load(currentStorageKey);
        String legacyStorageKey = "legacy-" + UUID.randomUUID() + ".html";
        Path legacyPath = currentPath.resolveSibling(legacyStorageKey);
        String legacyHtml = Files.readString(currentPath, StandardCharsets.UTF_8)
                .replace("selectIssue(selectedIssueId, false)", "selectIssue(selectedIssueId, true)")
                .replaceAll(" data-uni-accessibility-replay-bridge-sha256=\"[0-9a-f]{64}\"", "");
        Files.writeString(legacyPath, legacyHtml, StandardCharsets.UTF_8);
        fileStorage.deleteQuietly(currentStorageKey);
        artifact.replace(
                legacyStorageKey,
                artifact.getContentType(),
                Files.size(legacyPath),
                "0".repeat(64),
                artifact.getRequestedUrl(),
                artifact.getFinalUrl(),
                artifact.getCapturedAt(),
                artifact.getViewportWidthCssPx(),
                artifact.getViewportHeightCssPx(),
                artifact.getDeviceScaleFactor(),
                artifact.getPageWidthCssPx(),
                artifact.getPageHeightCssPx(),
                artifact.getCaptureMode()
        );
        artifactRepository.saveAndFlush(artifact);

        mockMvc.perform(get("/api/results/requests/{requestId}/artifact", request.getId()))
                .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/results/artifacts/{artifactId}/content", saved.id()))
                .andExpect(status().isNotFound());
        assertThat(artifactService.findStoredReplayBridgeRefreshCandidates()).containsExactly(saved.id());
        assertThat(artifactService.refreshStoredReplayBridge(saved.id())).isTrue();

        EvaluationArtifact refreshed = artifactRepository.findById(saved.id()).orElseThrow();
        byte[] refreshedBytes = artifactService.getContent(saved.id()).resource().getContentAsByteArray();
        assertThat(fileStorage.usesCurrentBridge(refreshed.getStorageKey())).isTrue();
        assertThat(refreshed.getSha256()).isNotEqualTo("0".repeat(64));
        assertThat(refreshed.getSizeBytes()).isEqualTo(refreshedBytes.length);
        assertThat(refreshed.getSha256()).isEqualTo(HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(refreshedBytes)
        ));
        assertThat(Files.exists(legacyPath)).isFalse();
        assertThat(new String(refreshedBytes, StandardCharsets.UTF_8))
                .contains("selectIssue(selectedIssueId, false, !issuesInitialized)")
                .doesNotContain("selectIssue(selectedIssueId, true, !issuesInitialized)");
    }

    @Test
    void rejectsLegacyCaptureModeForNewReplayUpload() {
        EvaluationRequest request = createRequest();
        EvaluationArtifactMetadataRequest legacyMetadata = new EvaluationArtifactMetadataRequest(
                "https://example.com/",
                "https://example.com/final",
                LocalDateTime.of(2026, 8, 11, 12, 0),
                1280,
                720,
                1.0,
                1280,
                720,
                CaptureMode.FULL_PAGE
        );

        assertThatThrownBy(() -> artifactService.replace(
                request.getId(), legacyMetadata, document("<main>Replay</main>")
        )).isInstanceOf(ArtifactValidationException.class)
                .hasMessageContaining("DOM_REPLAY");
        assertThat(artifactRepository.findByEvaluationRequestId(request.getId())).isEmpty();
    }

    @Test
    void failClosedDeletionRemovesDatabaseRowAndFileAfterCommit() {
        EvaluationRequest request = createRequest();
        EvaluationArtifactResponse saved = artifactService.replace(
                request.getId(), metadata(), document("<main>Replay</main>")
        );
        String storageKey = artifactRepository.findById(saved.id()).orElseThrow().getStorageKey();

        artifactService.deleteByRequestId(request.getId());

        assertThat(artifactRepository.findByEvaluationRequestId(request.getId())).isEmpty();
        assertThatThrownBy(() -> fileStorage.load(storageKey))
                .isInstanceOf(ArtifactFileStorage.ArtifactContentNotFoundException.class);
    }

    @Test
    void multipartUploadAndReadEndpointsHonorReplayAndSecurityContracts() throws Exception {
        EvaluationRequest request = createRequest();
        MockMultipartFile metadataPart = new MockMultipartFile(
                "metadata",
                "metadata.json",
                "application/json",
                """
                        {
                          "requestedUrl":"https://example.com/",
                          "finalUrl":"https://example.com/final",
                          "capturedAt":"2026-08-11T12:00:00",
                          "viewportWidthCssPx":1280,
                          "viewportHeightCssPx":720,
                          "deviceScaleFactor":1.0,
                          "pageWidthCssPx":1280,
                          "pageHeightCssPx":2000,
                          "captureMode":"DOM_REPLAY"
                        }
                        """.getBytes(StandardCharsets.UTF_8)
        );
        MockMultipartFile replayPart = document("""
                <!doctype html><html><body>
                <main id="target" onclick="bad()">Replay target</main>
                <script>bad()</script><iframe src="https://attacker.example"></iframe>
                </body></html>
                """);

        mockMvc.perform(multipart("/api/v1/evaluations/{requestId}/artifact", request.getId())
                        .file(metadataPart)
                        .file(replayPart))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.requestId").value(request.getId()))
                .andExpect(jsonPath("$.data.captureMode").value("DOM_REPLAY"))
                .andExpect(jsonPath("$.data.contentType").value("text/html"))
                .andExpect(jsonPath("$.data.imageWidthPx").doesNotExist())
                .andExpect(jsonPath("$.data.imageHeightPx").doesNotExist())
                .andExpect(jsonPath("$.data.contentUrl").value(org.hamcrest.Matchers.matchesPattern(
                        "/results/artifacts/[0-9]+/content"
                )));

        EvaluationArtifact artifact = artifactRepository.findByEvaluationRequestId(request.getId()).orElseThrow();
        mockMvc.perform(get("/api/results/requests/{requestId}/artifact", request.getId()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value(artifact.getId()))
                .andExpect(jsonPath("$.data.pageHeightCssPx").value(2000));

        mockMvc.perform(get("/api/results/artifacts/{artifactId}/content", artifact.getId()))
                .andExpect(status().isOk())
                .andExpect(content().contentType("text/html;charset=UTF-8"))
                .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.containsString("no-cache"),
                        org.hamcrest.Matchers.containsString("private")
                )))
                .andExpect(header().string(HttpHeaders.ETAG, org.hamcrest.Matchers.matchesPattern(
                        "W/\\\"sha256-[0-9a-f]{64}\\\""
                )))
                .andExpect(this::assertVaryAcceptEncoding)
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("Referrer-Policy", "no-referrer"))
                .andExpect(header().string("Content-Security-Policy", org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.containsString("sandbox allow-scripts"),
                        org.hamcrest.Matchers.containsString("script-src " + sanitizer.bridgeScriptCspSource()),
                        org.hamcrest.Matchers.containsString("connect-src 'none'"),
                        org.hamcrest.Matchers.containsString("form-action 'none'"),
                        org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("navigate-to"))
                )))
                .andExpect(content().string(org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.containsString("id=\"target\""),
                        org.hamcrest.Matchers.containsString("accessibility-page-replay"),
                        org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("onclick=")),
                        org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("<iframe")),
                        org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("bad()"))
                )));
    }

    @Test
    void revalidatesCachedReplayAndChangesEtagWhenContentIsReplaced() throws Exception {
        EvaluationRequest request = createRequest();
        EvaluationArtifactResponse first = artifactService.replace(
                request.getId(), metadata(), document("<main id=\"first\">First replay</main>")
        );

        MvcResult firstResponse = mockMvc.perform(get(
                        "/api/results/artifacts/{artifactId}/content", first.id()
                ))
                .andExpect(status().isOk())
                .andReturn();
        String firstEtag = firstResponse.getResponse().getHeader(HttpHeaders.ETAG);
        String storedSha256 = artifactRepository.findById(first.id()).orElseThrow().getSha256();
        assertThat(firstEtag).isEqualTo("W/\"sha256-" + storedSha256 + "\"");

        mockMvc.perform(get("/api/results/artifacts/{artifactId}/content", first.id())
                        .header(HttpHeaders.IF_NONE_MATCH, firstEtag))
                .andExpect(status().isNotModified())
                .andExpect(header().string(HttpHeaders.ETAG, firstEtag))
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.containsString("no-cache"),
                        org.hamcrest.Matchers.containsString("private")
                )))
                .andExpect(this::assertVaryAcceptEncoding)
                .andExpect(content().bytes(new byte[0]));

        EvaluationArtifactResponse replacement = artifactService.replace(
                request.getId(), metadata(), document("<main id=\"replacement\">Replacement replay</main>")
        );
        assertThat(replacement.id()).isEqualTo(first.id());

        mockMvc.perform(get("/api/results/artifacts/{artifactId}/content", replacement.id())
                        .header(HttpHeaders.IF_NONE_MATCH, firstEtag))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.ETAG, org.hamcrest.Matchers.not(firstEtag)))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("id=\"replacement\"")));
    }

    @Test
    void legacyPngRowsFailClosedUntilAReplayReplacesThem() throws Exception {
        EvaluationRequest request = createRequest();
        EvaluationArtifact legacy = artifactRepository.saveAndFlush(new EvaluationArtifact(
                request,
                "legacy.png",
                "image/png",
                100,
                "0".repeat(64),
                "https://example.com/",
                "https://example.com/",
                LocalDateTime.of(2026, 8, 11, 11, 0),
                1280,
                720,
                1.0,
                1280,
                720,
                CaptureMode.FULL_PAGE
        ));

        mockMvc.perform(get("/api/results/requests/{requestId}/artifact", request.getId()))
                .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/results/artifacts/{artifactId}/content", legacy.getId()))
                .andExpect(status().isNotFound());

        EvaluationArtifactResponse replacement = artifactService.replace(
                request.getId(), metadata(), document("<main id=\"migrated\">Migrated replay</main>")
        );

        assertThat(replacement.id()).isEqualTo(legacy.getId());
        assertThat(replacement.captureMode()).isEqualTo(CaptureMode.DOM_REPLAY);
        assertThat(replacement.contentType()).isEqualTo("text/html");
        mockMvc.perform(get("/api/results/requests/{requestId}/artifact", request.getId()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value(legacy.getId()))
                .andExpect(jsonPath("$.data.captureMode").value("DOM_REPLAY"));
        mockMvc.perform(get("/api/results/artifacts/{artifactId}/content", legacy.getId()))
                .andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("id=\"migrated\"")));
    }

    @Test
    void multipartUploadRejectsMissingMetadataAsBadRequest() throws Exception {
        EvaluationRequest request = createRequest();

        mockMvc.perform(multipart("/api/v1/evaluations/{requestId}/artifact", request.getId())
                        .file(document("<main>Replay</main>")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.success").value(false));
    }

    private EvaluationRequest createRequest() {
        Organization organization = organizationRepository.save(new Organization(
                "Artifact test organization",
                OrganizationType.ETC,
                null,
                null
        ));
        EvaluationTarget target = targetRepository.save(new EvaluationTarget(
                organization,
                "Example",
                TargetType.WEB,
                "https://example.com/",
                null
        ));
        return requestRepository.save(new EvaluationRequest(target, "artifact test"));
    }

    private EvaluationArtifactMetadataRequest metadata() {
        return new EvaluationArtifactMetadataRequest(
                "https://example.com/",
                "https://example.com/final",
                LocalDateTime.of(2026, 8, 11, 12, 0),
                1280,
                720,
                1.0,
                1280,
                2000,
                CaptureMode.DOM_REPLAY
        );
    }

    private MockMultipartFile document(String html) {
        return new MockMultipartFile(
                "document",
                "page.html",
                "text/html;charset=utf-8",
                ("<!doctype html><html><head><title>Replay</title></head><body>" + html + "</body></html>")
                        .getBytes(StandardCharsets.UTF_8)
        );
    }

    private void assertVaryAcceptEncoding(MvcResult result) {
        assertThat(result.getResponse().getHeaders(HttpHeaders.VARY))
                .anySatisfy(value -> assertThat(value).containsIgnoringCase(HttpHeaders.ACCEPT_ENCODING));
    }
}
