package com.accessibility.platform.capturemetadata;

import com.accessibility.platform.AccessibilityPlatformApplication;
import com.accessibility.platform.capturemetadata.domain.EvaluationCaptureMetadata;
import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.integration.service.AiEvaluationIngestionService;
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
import org.springframework.context.ConfigurableApplicationContext;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.LocalDateTime;

import static org.assertj.core.api.Assertions.assertThat;

class LegacyCaptureMetadataSchemaMigrationTest {

    @Test
    void preservesLegacyRowsAndAllowsMetadataOnlyInserts(@TempDir Path temporaryDirectory) throws Exception {
        String databasePath = temporaryDirectory.resolve("legacy-capture-db")
                .toAbsolutePath()
                .toString()
                .replace('\\', '/');
        String jdbcUrl = "jdbc:h2:file:" + databasePath + ";DB_CLOSE_ON_EXIT=FALSE";

        Long legacyMetadataId;
        try (ConfigurableApplicationContext context = startApplication(jdbcUrl)) {
            EvaluationRequest request = createRequest(context, "Legacy capture", "https://example.com/legacy");
            EvaluationCaptureMetadata metadata = context.getBean(EvaluationCaptureMetadataRepository.class)
                    .saveAndFlush(new EvaluationCaptureMetadata(
                            request,
                            "https://example.com/legacy",
                            "https://example.com/legacy-final",
                            LocalDateTime.of(2026, 8, 11, 10, 0),
                            1280,
                            720,
                            1.0,
                            1280,
                            1600
                    ));
            legacyMetadataId = metadata.getId();
        }

        addLegacyReplayColumns(jdbcUrl);

        Long newRequestId;
        try (ConfigurableApplicationContext context = startApplication(jdbcUrl)) {
            EvaluationCaptureMetadata preserved = context.getBean(EvaluationCaptureMetadataRepository.class)
                    .findById(legacyMetadataId)
                    .orElseThrow();
            assertThat(preserved.getFinalUrl()).isEqualTo("https://example.com/legacy-final");

            EvaluationRequest request = createRequest(
                    context,
                    "Metadata-only capture",
                    "https://example.org/requested"
            );
            newRequestId = request.getId();
            context.getBean(AiEvaluationIngestionService.class).save("""
                    {
                      "url":"https://example.org/requested",
                      "request_id":%d,
                      "capture_metadata":{
                        "requestedUrl":"https://example.org/requested",
                        "finalUrl":"https://example.org/final",
                        "capturedAt":"2026-09-03T12:00:00",
                        "viewportWidthCssPx":1440,
                        "viewportHeightCssPx":900,
                        "deviceScaleFactor":1.0,
                        "pageWidthCssPx":1440,
                        "pageHeightCssPx":2600
                      },
                      "total_score":90,
                      "score_breakdown":{"module_scores":{"rule_based":90}},
                      "modules":{}
                    }
                    """.formatted(newRequestId));
        }

        try (var connection = DriverManager.getConnection(jdbcUrl, "sa", "");
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("""
                     SELECT storage_key, content_type, size_bytes, sha256, capture_mode
                     FROM evaluation_artifact
                     WHERE evaluation_request_id = %d
                     """.formatted(newRequestId))) {
            assertThat(rows.next()).isTrue();
            assertThat(rows.getString("storage_key")).isNull();
            assertThat(rows.getString("content_type")).isNull();
            assertThat(rows.getObject("size_bytes")).isNull();
            assertThat(rows.getString("sha256")).isNull();
            assertThat(rows.getString("capture_mode")).isNull();
        }
    }

    private ConfigurableApplicationContext startApplication(String jdbcUrl) {
        return new SpringApplicationBuilder(AccessibilityPlatformApplication.class)
                .web(WebApplicationType.NONE)
                .registerShutdownHook(false)
                .run(
                        "--spring.datasource.url=" + jdbcUrl,
                        "--spring.datasource.username=sa",
                        "--spring.datasource.password=",
                        "--spring.jpa.hibernate.ddl-auto=update",
                        "--spring.jpa.open-in-view=false",
                        "--spring.jpa.show-sql=false",
                        "--spring.h2.console.enabled=false",
                        "--spring.sql.init.mode=always"
                );
    }

    private EvaluationRequest createRequest(
            ConfigurableApplicationContext context,
            String name,
            String url
    ) {
        Organization organization = context.getBean(OrganizationRepository.class).save(new Organization(
                name,
                OrganizationType.ETC,
                null,
                null
        ));
        EvaluationTarget target = context.getBean(EvaluationTargetRepository.class).save(new EvaluationTarget(
                organization,
                name,
                TargetType.WEB,
                url,
                null,
                null
        ));
        return context.getBean(EvaluationRequestRepository.class).save(new EvaluationRequest(target, name));
    }

    private void addLegacyReplayColumns(String jdbcUrl) throws Exception {
        try (var connection = DriverManager.getConnection(jdbcUrl, "sa", "");
             Statement statement = connection.createStatement()) {
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ADD COLUMN storage_key VARCHAR(100) DEFAULT 'legacy.html' NOT NULL
                    """);
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ADD COLUMN content_type VARCHAR(20) DEFAULT 'text/html' NOT NULL
                    """);
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ADD COLUMN size_bytes BIGINT DEFAULT 128 NOT NULL
                    """);
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ADD COLUMN sha256 VARCHAR(64) DEFAULT 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' NOT NULL
                    """);
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ADD COLUMN image_width_px INTEGER DEFAULT 0 NOT NULL
                    """);
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ADD COLUMN image_height_px INTEGER DEFAULT 0 NOT NULL
                    """);
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ADD COLUMN capture_mode ENUM('FULL_PAGE', 'TILE', 'VIEWPORT')
                    DEFAULT 'FULL_PAGE' NOT NULL
                    """);
            statement.execute("""
                    ALTER TABLE evaluation_artifact
                    ADD CONSTRAINT uk_evaluation_artifact_storage_key UNIQUE (storage_key)
                    """);

            // The enum and unique storage-key constraint reproduce the legacy
            // replay schema. Defaults model the existing row; remove them so a
            // new metadata-only insert proves startup migration really relaxed
            // the old file requirements instead of silently filling them.
            statement.execute("ALTER TABLE evaluation_artifact ALTER COLUMN storage_key DROP DEFAULT");
            statement.execute("ALTER TABLE evaluation_artifact ALTER COLUMN content_type DROP DEFAULT");
            statement.execute("ALTER TABLE evaluation_artifact ALTER COLUMN size_bytes DROP DEFAULT");
            statement.execute("ALTER TABLE evaluation_artifact ALTER COLUMN sha256 DROP DEFAULT");
            statement.execute("ALTER TABLE evaluation_artifact ALTER COLUMN image_width_px DROP DEFAULT");
            statement.execute("ALTER TABLE evaluation_artifact ALTER COLUMN image_height_px DROP DEFAULT");
            statement.execute("ALTER TABLE evaluation_artifact ALTER COLUMN capture_mode DROP DEFAULT");
        }
    }
}
