package com.accessibility.platform.request.repository;

import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.target.domain.TargetStatus;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface EvaluationRequestRepository extends JpaRepository<EvaluationRequest, Long> {
    List<EvaluationRequest> findByEvaluationTargetId(Long evaluationTargetId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select request from EvaluationRequest request where request.id = :id")
    Optional<EvaluationRequest> findByIdForUpdate(@Param("id") Long id);

    @Query("""
            select evaluationRequest
            from EvaluationRequest evaluationRequest
            join fetch evaluationRequest.evaluationTarget target
            join fetch target.organization organization
            where organization.status = :organizationStatus
              and target.status = :targetStatus
            order by evaluationRequest.updatedAt asc, evaluationRequest.id asc
            """)
    List<EvaluationRequest> findDashboardRequests(
            @Param("organizationStatus") OrganizationStatus organizationStatus,
            @Param("targetStatus") TargetStatus targetStatus
    );
}
