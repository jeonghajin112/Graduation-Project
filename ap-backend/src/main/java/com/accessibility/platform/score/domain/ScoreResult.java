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

    @Column(nullable = false, precision = 5, scale = 2)
    private BigDecimal aiScore;

    @Column(nullable = false, precision = 5, scale = 2)
    private BigDecimal cvScore;

    public ScoreResult(EvaluationRequest evaluationRequest, BigDecimal totalScore, BigDecimal ruleScore, BigDecimal aiScore, BigDecimal cvScore) {
        this.evaluationRequest = evaluationRequest;
        this.totalScore = totalScore;
        this.ruleScore = ruleScore;
        this.aiScore = aiScore;
        this.cvScore = cvScore;
    }
}
