package com.accessibility.platform.score.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import com.accessibility.platform.request.domain.EvaluationRequest;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;

@Getter
@Entity
@Table(name = "score_result")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class ScoreResult extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "evaluation_request_id", nullable = false, unique = true)
    private EvaluationRequest evaluationRequest;

    @Column(nullable = false, precision = 5, scale = 2)
    private BigDecimal totalScore;

    @Column(nullable = false, precision = 5, scale = 2)
    private BigDecimal ruleScore;

    // Null when the text analysis failed; a failed run is not a 0 score.
    @Column(precision = 5, scale = 2)
    private BigDecimal aiScore;

    @Column(precision = 5, scale = 2)
    private BigDecimal cvScore;

    // Null status preserves uncertainty in historical rows; never reclassify an
    // old numeric zero as an empty OCR result without its original evidence.
    @Enumerated(EnumType.STRING)
    @Column(length = 20)
    private CvScoreStatus cvStatus;

    // Null in historical rows, whose text analysis outcome was not recorded.
    @Enumerated(EnumType.STRING)
    @Column(length = 20)
    private TextScoreStatus textStatus;

    public ScoreResult(EvaluationRequest evaluationRequest, BigDecimal totalScore, BigDecimal ruleScore, BigDecimal aiScore, BigDecimal cvScore) {
        this(evaluationRequest, totalScore, ruleScore, aiScore, cvScore, null);
    }

    public ScoreResult(EvaluationRequest evaluationRequest, BigDecimal totalScore, BigDecimal ruleScore, BigDecimal aiScore, BigDecimal cvScore, CvScoreStatus cvStatus) {
        this(evaluationRequest, totalScore, ruleScore, aiScore, cvScore, cvStatus, null);
    }

    public ScoreResult(EvaluationRequest evaluationRequest, BigDecimal totalScore, BigDecimal ruleScore, BigDecimal aiScore, BigDecimal cvScore, CvScoreStatus cvStatus, TextScoreStatus textStatus) {
        this.evaluationRequest = evaluationRequest;
        this.totalScore = totalScore;
        this.ruleScore = ruleScore;
        this.aiScore = aiScore;
        this.cvScore = cvScore;
        this.cvStatus = cvStatus;
        this.textStatus = textStatus;
    }
}
