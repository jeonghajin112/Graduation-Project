package com.accessibility.platform.guide.repository;

import com.accessibility.platform.guide.domain.ImprovementGuide;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface ImprovementGuideRepository extends JpaRepository<ImprovementGuide, Long> {
    Optional<ImprovementGuide> findByIssueResultId(Long issueResultId);
}
