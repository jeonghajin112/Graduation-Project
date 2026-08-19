package com.accessibility.platform.request.repository;

import com.accessibility.platform.request.domain.EvaluationRequest;
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
}
