package com.accessibility.platform.artifact.repository;

import com.accessibility.platform.artifact.domain.EvaluationArtifact;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;

public interface EvaluationArtifactRepository extends JpaRepository<EvaluationArtifact, Long> {
    Optional<EvaluationArtifact> findByEvaluationRequestId(Long evaluationRequestId);

    @Query("select artifact.finalUrl from EvaluationArtifact artifact where artifact.evaluationRequest.id = :requestId")
    Optional<String> findFinalUrlByRequestId(@Param("requestId") Long requestId);
}
