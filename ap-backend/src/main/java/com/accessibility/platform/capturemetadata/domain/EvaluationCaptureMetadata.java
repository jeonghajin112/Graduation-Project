package com.accessibility.platform.capturemetadata.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import com.accessibility.platform.request.domain.EvaluationRequest;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.OneToOne;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

/**
 * Analysis-time browser geometry used to align issues with the live report.
 *
 * <p>The table name intentionally remains {@code evaluation_artifact}. Existing
 * installations can retain their historical rows while the application stops
 * reading or writing the legacy replay-file columns.</p>
 */
@Getter
@Entity
@Table(
        name = "evaluation_artifact",
        uniqueConstraints = @UniqueConstraint(
                name = "uk_evaluation_artifact_request",
                columnNames = "evaluation_request_id"
        )
)
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class EvaluationCaptureMetadata extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "evaluation_request_id", nullable = false)
    private EvaluationRequest evaluationRequest;

    @Column(nullable = false, length = 2048)
    private String requestedUrl;

    @Column(nullable = false, length = 2048)
    private String finalUrl;

    @Column(nullable = false)
    private LocalDateTime capturedAt;

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

    public EvaluationCaptureMetadata(
            EvaluationRequest evaluationRequest,
            String requestedUrl,
            String finalUrl,
            LocalDateTime capturedAt,
            int viewportWidthCssPx,
            int viewportHeightCssPx,
            double deviceScaleFactor,
            int pageWidthCssPx,
            int pageHeightCssPx
    ) {
        this.evaluationRequest = evaluationRequest;
        replace(
                requestedUrl,
                finalUrl,
                capturedAt,
                viewportWidthCssPx,
                viewportHeightCssPx,
                deviceScaleFactor,
                pageWidthCssPx,
                pageHeightCssPx
        );
    }

    public void replace(
            String requestedUrl,
            String finalUrl,
            LocalDateTime capturedAt,
            int viewportWidthCssPx,
            int viewportHeightCssPx,
            double deviceScaleFactor,
            int pageWidthCssPx,
            int pageHeightCssPx
    ) {
        this.requestedUrl = requestedUrl;
        this.finalUrl = finalUrl;
        this.capturedAt = capturedAt;
        this.viewportWidthCssPx = viewportWidthCssPx;
        this.viewportHeightCssPx = viewportHeightCssPx;
        this.deviceScaleFactor = deviceScaleFactor;
        this.pageWidthCssPx = pageWidthCssPx;
        this.pageHeightCssPx = pageHeightCssPx;
    }
}
