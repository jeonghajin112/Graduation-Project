package com.accessibility.platform.request.repository;

import com.accessibility.platform.request.domain.AnalysisSubmission;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AnalysisSubmissionRepository extends JpaRepository<AnalysisSubmission, String> {}
