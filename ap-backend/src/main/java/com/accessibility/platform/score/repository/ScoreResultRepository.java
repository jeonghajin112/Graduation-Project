package com.accessibility.platform.score.repository;

import com.accessibility.platform.score.domain.ScoreResult;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface ScoreResultRepository extends JpaRepository<ScoreResult, Long> {
    Optional<ScoreResult> findByEvaluationRequestId(Long evaluationRequestId);
}
