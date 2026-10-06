package com.accessibility.platform.request.domain;

import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class AnalysisSubmission {
    @Id
    @Column(length = 36, updatable = false)
    private String id;

    @Column(nullable = false, length = 64, updatable = false)
    private String requestHash;

    @OneToOne(fetch = FetchType.LAZY)
    private EvaluationRequest evaluationRequest;

    public AnalysisSubmission(String id, String requestHash) {
        this.id = id;
        this.requestHash = requestHash;
    }

    public void accept(EvaluationRequest request) { this.evaluationRequest = request; }
}
