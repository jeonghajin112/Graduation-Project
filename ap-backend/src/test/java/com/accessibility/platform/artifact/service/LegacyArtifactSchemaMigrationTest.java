package com.accessibility.platform.artifact.service;

import com.accessibility.platform.AccessibilityPlatformApplication;
import com.accessibility.platform.artifact.domain.CaptureMode;
import com.accessibility.platform.artifact.domain.EvaluationArtifact;
import com.accessibility.platform.artifact.repository.EvaluationArtifactRepository;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LegacyArtifactSchemaMigrationTest {

    @Test
    void widensLegacyH2EnumBeforeJpaAndAcceptsReplayUpload(@TempDir Path temporaryDirectory) throws Exception {
        String databasePath = temporaryDirectory.resolve("legacy-artifact-db")
                .toAbsolutePath()
                .toString()
                .replace('\\', '/');
        String jdbcUrl = "jdbc:h2:file:" + databasePath + ";DB_CLOSE_ON_EXIT=FALSE";
        Path artifactDirectory = temporaryDirectory.resolve("artifacts");

        Long requestId;
        Long legacyArtifactId;
        try (ConfigurableApplicationContext context = startApplication(
                WebApplicationType.NONE, jdbcUrl, artifactDirectory
        )) {
            Organization organization = context.getBean(OrganizationRepository.class).save(new Organization(
                    "Legacy migration organization", OrganizationType.ETC, null, null
            ));
            EvaluationTarget target = context.getBean(EvaluationTargetRepository.class).save(new EvaluationTarget(
                    organization, "Legacy target", TargetType.WEB, "https://example.com/", null
            ));
            EvaluationRequest request = context.getBean(EvaluationRequestRepository.class).save(new EvaluationRequest(
                    target, "legacy artifact migration"
            ));
            EvaluationArtifact legacyArtifact = context.getBean(EvaluationArtifactRepository.class).saveAndFlush(
                    new EvaluationArtifact(
                            request,
                            "legacy.png",
                            "image/png",
                            100,
                            "0".repeat(64),
                            "https://example.com/",
                            "https://example.com/legacy",
                            LocalDateTime.of(2026, 8, 11, 10, 0),
                            1280,
                            720,
                            1.0,
                            1280,
                            720,
                            CaptureMode.FULL_PAGE
                    )
            );
            requestId = request.getId();
            legacyArtifactId = legacyArtifact.getId();
        }

        installLegacyCaptureModeConstraint(jdbcUrl, legacyArtifactId);

        try (ConfigurableApplicationContext context = startApplication(
                WebApplicationType.SERVLET, jdbcUrl, artifactDirectory
        )) {
            EvaluationArtifact preserved = context.getBean(EvaluationArtifactRepository.class)
                    .findById(legacyArtifactId)
                    .orElseThrow();
            assertThat(preserved.getCaptureMode()).isEqualTo(CaptureMode.FULL_PAGE);

            int port = ((WebServerApplicationContext) context).getWebServer().getPort();
            HttpResponse<String> uploadResponse = uploadReplay(port, requestId);

            assertThat(uploadResponse.statusCode()).isEqualTo(200);
            assertThat(uploadResponse.body())
                    .contains("\"success\":true", "\"captureMode\":\"DOM_REPLAY\"", "\"contentType\":\"text/html\"");

            EvaluationArtifact migrated = context.getBean(EvaluationArtifactRepository.class)
                    .findById(legacyArtifactId)
                    .orElseThrow();
            assertThat(migrated.getEvaluationRequest().getId()).isEqualTo(requestId);
            assertThat(migrated.getCaptureMode()).isEqualTo(CaptureMode.DOM_REPLAY);
            assertThat(migrated.getStorageKey()).endsWith(".html");
            assertThat(context.getBean(EvaluationArtifactRepository.class).count()).isEqualTo(1);
        }

        // The migration runs on every startup. A database that already stores
        // DOM_REPLAY must remain valid and retain its artifact on the next boot.
        try (ConfigurableApplicationContext context = startApplication(
                WebApplicationType.NONE, jdbcUrl, artifactDirectory
        )) {
            EvaluationArtifact retained = context.getBean(EvaluationArtifactRepository.class)
                    .findById(legacyArtifactId)
                    .orElseThrow();
            assertThat(retained.getCaptureMode()).isEqualTo(CaptureMode.DOM_REPLAY);
            assertThat(retained.getStorageKey()).endsWith(".html");
        }
    }

    private ConfigurableApplicationContext startApplication(
            WebApplicationType webApplicationType,
            String jdbcUrl,
            Path artifactDirectory
    ) {
        return new SpringApplicationBuilder(AccessibilityPlatformApplication.class)
                .web(webApplicationType)
                .registerShutdownHook(false)
                .run(
                        "--spring.datasource.url=" + jdbcUrl,
                        "--spring.datasource.username=sa",
                        "--spring.datasource.password=",
                        "--spring.jpa.hibernate.ddl-auto=update",
                        "--spring.jpa.open-in-view=false",
                        "--spring.jpa.show-sql=false",
                        "--spring.h2.console.enabled=false",
                        "--spring.sql.init.mode=always",
                        "--server.port=0",
                        "--accessibility.artifacts.directory=" + artifactDirectory.toAbsolutePath(),
                        "--accessibility.artifacts.max-file-size-bytes=1048576"
                );
    }

    private void installLegacyCaptureModeConstraint(String jdbcUrl, Long legacyArtifactId) throws Exception {
        try (var connection = DriverManager.getConnection(jdbcUrl, "sa", "");
             Statement statement = connection.createStatement()) {
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ALTER COLUMN capture_mode ENUM('FULL_PAGE', 'TILE', 'VIEWPORT')
                    """);

            assertThatThrownBy(() -> statement.executeUpdate(
                    "UPDATE evaluation_artifact SET capture_mode = 'DOM_REPLAY' WHERE id = " + legacyArtifactId
            )).isInstanceOf(SQLException.class)
                    .hasMessageContaining("DOM_REPLAY");

            try (ResultSet rows = statement.executeQuery(
                    "SELECT capture_mode FROM evaluation_artifact WHERE id = " + legacyArtifactId
            )) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getString(1)).isEqualTo("FULL_PAGE");
            }
        }
    }

    private HttpResponse<String> uploadReplay(int port, Long requestId) throws Exception {
        String boundary = "----accessibility-replay-" + UUID.randomUUID();
        String metadata = """
                {
                  "requestedUrl":"https://example.com/",
                  "finalUrl":"https://example.com/final",
                  "capturedAt":"2026-08-11T12:00:00",
                  "viewportWidthCssPx":1280,
                  "viewportHeightCssPx":720,
                  "deviceScaleFactor":1.0,
                  "pageWidthCssPx":1280,
                  "pageHeightCssPx":1600,
                  "captureMode":"DOM_REPLAY"
                }
                """;
        String document = """
                <!doctype html><html><body>
                <main id="migrated">Migrated replay</main><script>mustNotRun()</script>
                </body></html>
                """;
        String body = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"metadata\"; filename=\"metadata.json\"\r\n"
                + "Content-Type: application/json\r\n\r\n"
                + metadata + "\r\n"
                + "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"document\"; filename=\"page.html\"\r\n"
                + "Content-Type: text/html; charset=utf-8\r\n\r\n"
                + document + "\r\n"
                + "--" + boundary + "--\r\n";

        HttpRequest request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v1/evaluations/" + requestId + "/artifact")
                )
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body.getBytes(StandardCharsets.UTF_8)))
                .build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }
}
