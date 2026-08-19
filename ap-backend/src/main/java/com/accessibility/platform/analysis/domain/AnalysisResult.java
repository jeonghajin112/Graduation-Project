package com.accessibility.platform.analysis.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import com.accessibility.platform.request.domain.EvaluationRequest;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Getter
@Entity
@Table(name = "analysis_result")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class AnalysisResult extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "evaluation_request_id", nullable = false)
    private EvaluationRequest evaluationRequest;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private AnalyzerType analyzerType;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private AnalysisStatus status;

    @Column(length = 1000)
    private String summary;

    private LocalDateTime startedAt;
    private LocalDateTime completedAt;

    public AnalysisResult(EvaluationRequest evaluationRequest, AnalyzerType analyzerType, AnalysisStatus status, String summary, LocalDateTime startedAt, LocalDateTime completedAt) {
        this.evaluationRequest = evaluationRequest;
        this.analyzerType = analyzerType;
        this.status = status;
        this.summary = summary;
        this.startedAt = startedAt;
        this.completedAt = completedAt;
    }
}
