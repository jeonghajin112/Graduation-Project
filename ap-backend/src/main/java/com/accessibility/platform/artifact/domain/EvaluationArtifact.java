package com.accessibility.platform.artifact.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import com.accessibility.platform.request.domain.EvaluationRequest;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Getter
@Entity
@Table(
        name = "evaluation_artifact",
        uniqueConstraints = {
                @UniqueConstraint(name = "uk_evaluation_artifact_request", columnNames = "evaluation_request_id"),
                @UniqueConstraint(name = "uk_evaluation_artifact_storage_key", columnNames = "storage_key")
        }
)
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class EvaluationArtifact extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "evaluation_request_id", nullable = false)
    private EvaluationRequest evaluationRequest;

    @Column(name = "storage_key", nullable = false, length = 100)
    private String storageKey;

    @Column(nullable = false, length = 20)
    private String contentType;

    @Column(nullable = false)
    private long sizeBytes;

    @Column(nullable = false, length = 64)
    private String sha256;

    @Column(nullable = false, length = 2048)
    private String requestedUrl;

    @Column(nullable = false, length = 2048)
    private String finalUrl;

    @Column(nullable = false)
    private LocalDateTime capturedAt;

    @Column(nullable = false)
    private int imageWidthPx;

    @Column(nullable = false)
    private int imageHeightPx;

    @Column(nullable = false)
    private int viewportWidthCssPx;

    @Column(nullable = false)
    private int viewportHeightCssPx;

    @Column(nullable = false)
    private double deviceScaleFactor;

    @Column(nullable = false)
    private int pageWidthCssPx;

    @Column(nullable = false)
    private int pageHeightCssPx;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private CaptureMode captureMode;

    public EvaluationArtifact(
            EvaluationRequest evaluationRequest,
            String storageKey,
            String contentType,
            long sizeBytes,
            String sha256,
            String requestedUrl,
            String finalUrl,
            LocalDateTime capturedAt,
            int viewportWidthCssPx,
            int viewportHeightCssPx,
            double deviceScaleFactor,
            int pageWidthCssPx,
            int pageHeightCssPx,
            CaptureMode captureMode
    ) {
        this.evaluationRequest = evaluationRequest;
        replace(
                storageKey,
                contentType,
                sizeBytes,
                sha256,
                requestedUrl,
                finalUrl,
                capturedAt,
                viewportWidthCssPx,
                viewportHeightCssPx,
                deviceScaleFactor,
                pageWidthCssPx,
                pageHeightCssPx,
                captureMode
        );
    }

    public void replace(
            String storageKey,
            String contentType,
            long sizeBytes,
            String sha256,
            String requestedUrl,
            String finalUrl,
            LocalDateTime capturedAt,
            int viewportWidthCssPx,
            int viewportHeightCssPx,
            double deviceScaleFactor,
            int pageWidthCssPx,
            int pageHeightCssPx,
            CaptureMode captureMode
    ) {
        this.storageKey = storageKey;
        this.contentType = contentType;
        this.sizeBytes = sizeBytes;
        this.sha256 = sha256;
        this.requestedUrl = requestedUrl;
        this.finalUrl = finalUrl;
        this.capturedAt = capturedAt;
        // Legacy PNG columns stay zero-valued so existing H2 schemas can be
        // upgraded without dropping their original NOT NULL columns.
        this.imageWidthPx = 0;
        this.imageHeightPx = 0;
        this.viewportWidthCssPx = viewportWidthCssPx;
        this.viewportHeightCssPx = viewportHeightCssPx;
        this.deviceScaleFactor = deviceScaleFactor;
        this.pageWidthCssPx = pageWidthCssPx;
        this.pageHeightCssPx = pageHeightCssPx;
        this.captureMode = captureMode;
    }
}
