package com.accessibility.platform.target.repository;

import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface EvaluationTargetRepository extends JpaRepository<EvaluationTarget, Long> {
    List<EvaluationTarget> findByOrganizationId(Long organizationId);
    List<EvaluationTarget> findByOrganizationIdAndStatusNot(Long organizationId, TargetStatus status);
    List<EvaluationTarget> findAllByAccessUrlOrderByIdDesc(String accessUrl);
    Optional<EvaluationTarget> findByAccessUrl(String accessUrl);

    @Query("""
            select target
            from EvaluationTarget target
            join fetch target.organization organization
            where organization.status = :organizationStatus
              and target.status = :targetStatus
            order by organization.id asc, target.id asc
            """)
    List<EvaluationTarget> findDashboardTargets(
            @Param("organizationStatus") OrganizationStatus organizationStatus,
            @Param("targetStatus") TargetStatus targetStatus
    );
}
