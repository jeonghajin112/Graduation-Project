package com.accessibility.platform.artifact.repository;

import com.accessibility.platform.artifact.domain.EvaluationArtifact;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface EvaluationArtifactRepository extends JpaRepository<EvaluationArtifact, Long> {
    Optional<EvaluationArtifact> findByEvaluationRequestId(Long evaluationRequestId);
}
