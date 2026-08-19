package com.accessibility.platform.target.repository;

import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetStatus;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface EvaluationTargetRepository extends JpaRepository<EvaluationTarget, Long> {
    List<EvaluationTarget> findByOrganizationId(Long organizationId);
    List<EvaluationTarget> findByOrganizationIdAndStatusNot(Long organizationId, TargetStatus status);
    List<EvaluationTarget> findAllByAccessUrlOrderByIdDesc(String accessUrl);
    Optional<EvaluationTarget> findByAccessUrl(String accessUrl);
}
