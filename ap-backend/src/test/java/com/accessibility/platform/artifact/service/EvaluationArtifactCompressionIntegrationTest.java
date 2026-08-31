package com.accessibility.platform.artifact.service;

import com.accessibility.platform.artifact.dto.EvaluationArtifactMetadataRequest;
import com.accessibility.platform.artifact.dto.EvaluationArtifactResponse;
import com.accessibility.platform.artifact.domain.CaptureMode;
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
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.mock.web.MockMultipartFile;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.zip.GZIPInputStream;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "server.compression.enabled=true"
)
class EvaluationArtifactCompressionIntegrationTest {

    @LocalServerPort
    int port;

    @Autowired
    EvaluationArtifactService artifactService;

    @Autowired
    ArtifactFileStorage fileStorage;

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
    void compressesReplayHtmlForClientsThatAcceptGzip() throws Exception {
        EvaluationRequest request = createRequest();
        EvaluationArtifactResponse artifact = artifactService.replace(
                request.getId(),
                metadata(),
                new MockMultipartFile(
                        "document",
                        "page.html",
                        "text/html;charset=utf-8",
                        "<!doctype html><html><body><main>Compressible replay</main></body></html>"
                                .getBytes(StandardCharsets.UTF_8)
                )
        );
        long uncompressedSize = artifactRepository.findById(artifact.id()).orElseThrow().getSizeBytes();

        HttpRequest contentRequest = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port
                        + "/api/results/artifacts/" + artifact.id() + "/content"))
                .header("Accept-Encoding", "gzip")
                .GET()
                .build();
        HttpResponse<byte[]> response = HttpClient.newHttpClient().send(
                contentRequest,
                HttpResponse.BodyHandlers.ofByteArray()
        );

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("Content-Encoding")).contains("gzip");
        assertThat(response.headers().allValues("Vary"))
                .anySatisfy(value -> assertThat(value).containsIgnoringCase("Accept-Encoding"));
        assertThat(response.headers().firstValue("ETag")).hasValueSatisfying(
                value -> assertThat(value).startsWith("W/\"sha256-")
        );
        assertThat((long) response.body().length).isLessThan(uncompressedSize);

        String decompressed;
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(response.body()))) {
            decompressed = new String(gzip.readAllBytes(), StandardCharsets.UTF_8);
        }
        assertThat(decompressed).contains("Compressible replay", "accessibility-page-replay");
        assertThat(decompressed.getBytes(StandardCharsets.UTF_8)).hasSize((int) uncompressedSize);
    }

    private EvaluationRequest createRequest() {
        Organization organization = organizationRepository.save(new Organization(
                "Compression test organization",
                OrganizationType.ETC,
                null,
                null
        ));
        EvaluationTarget target = targetRepository.save(new EvaluationTarget(
                organization,
                "Compression target",
                TargetType.WEB,
                "https://example.com/",
                null
        ));
        return requestRepository.save(new EvaluationRequest(target, "compression test"));
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
}
