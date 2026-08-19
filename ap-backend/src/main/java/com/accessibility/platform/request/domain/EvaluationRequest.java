package com.accessibility.platform.request.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import com.accessibility.platform.target.domain.EvaluationTarget;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Getter
@Entity
@Table(name = "evaluation_request")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class EvaluationRequest extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "evaluation_target_id", nullable = false)
    private EvaluationTarget evaluationTarget;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private EvaluationRequestStatus status;

    @Column(length = 500)
    private String requestNote;

    @Column(nullable = false)
    private LocalDateTime requestedAt;

    public EvaluationRequest(EvaluationTarget evaluationTarget, String requestNote) {
        this.evaluationTarget = evaluationTarget;
        this.requestNote = requestNote;
        this.status = EvaluationRequestStatus.PENDING;
        this.requestedAt = LocalDateTime.now();
    }

    public void changeStatus(EvaluationRequestStatus status) {
        this.status = status;
    }
}
