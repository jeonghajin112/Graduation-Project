package com.accessibility.platform.target.repository;

import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface EvaluationTargetRepository extends JpaRepository<EvaluationTarget, Long> {
    @Query("select t from EvaluationTarget t join fetch t.organization where t.id = :id")
    Optional<EvaluationTarget> findWithOrganizationById(@Param("id") Long id);

    @Transactional
    @Modifying(clearAutomatically = true)
    @Query("""
            update EvaluationTarget t set t.faviconUrl = :faviconUrl
            where t.id = :id and t.accessUrl = :expectedUrl and t.status <> :deleted
            """)
    int updateFaviconIfUrlUnchanged(@Param("id") Long id, @Param("expectedUrl") String expectedUrl,
                                   @Param("faviconUrl") String faviconUrl, @Param("deleted") TargetStatus deleted);

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
