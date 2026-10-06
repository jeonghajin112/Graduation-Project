package com.accessibility.platform.score.repository;

import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.score.domain.ScoreResult;
import com.accessibility.platform.target.domain.TargetStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface ScoreResultRepository extends JpaRepository<ScoreResult, Long> {
    Optional<ScoreResult> findByEvaluationRequestId(Long evaluationRequestId);

    @Query("""
            select scoreResult
            from ScoreResult scoreResult
            join fetch scoreResult.evaluationRequest evaluationRequest
            join evaluationRequest.evaluationTarget target
            join target.organization organization
            where organization.status = :organizationStatus
              and target.status = :targetStatus
              and evaluationRequest.status = :requestStatus
            order by evaluationRequest.updatedAt asc, evaluationRequest.id asc
            """)
    List<ScoreResult> findDashboardScores(
            @Param("organizationStatus") OrganizationStatus organizationStatus,
            @Param("targetStatus") TargetStatus targetStatus,
            @Param("requestStatus") EvaluationRequestStatus requestStatus
    );
}
