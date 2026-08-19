package com.accessibility.platform.analysis.repository;

import com.accessibility.platform.analysis.domain.IssueResult;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface IssueResultRepository extends JpaRepository<IssueResult, Long> {
    List<IssueResult> findByAnalysisResultId(Long analysisResultId);
}
