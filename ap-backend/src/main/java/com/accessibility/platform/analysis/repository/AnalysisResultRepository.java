package com.accessibility.platform.analysis.repository;

import com.accessibility.platform.analysis.domain.AnalysisResult;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface AnalysisResultRepository extends JpaRepository<AnalysisResult, Long> {
    List<AnalysisResult> findByEvaluationRequestId(Long evaluationRequestId);
}
