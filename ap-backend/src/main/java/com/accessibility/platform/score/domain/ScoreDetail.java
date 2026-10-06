package com.accessibility.platform.score.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;

@Getter
@Entity
@Table(name = "score_detail")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class ScoreDetail extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "score_result_id", nullable = false)
    private ScoreResult scoreResult;

    @Column(nullable = false, length = 100)
    private String category;

    @Column(nullable = false, precision = 5, scale = 2)
    private BigDecimal score;

    @Column(nullable = false, precision = 5, scale = 2)
    private BigDecimal maxScore;

    @Column(length = 500)
    private String comment;

    public ScoreDetail(ScoreResult scoreResult, String category, BigDecimal score, BigDecimal maxScore, String comment) {
        this.scoreResult = scoreResult;
        this.category = category;
        this.score = score;
        this.maxScore = maxScore;
        this.comment = comment;
    }
}
