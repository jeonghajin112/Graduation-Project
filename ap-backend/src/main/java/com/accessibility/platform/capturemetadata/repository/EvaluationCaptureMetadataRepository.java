package com.accessibility.platform.capturemetadata.repository;

import com.accessibility.platform.capturemetadata.domain.EvaluationCaptureMetadata;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;

public interface EvaluationCaptureMetadataRepository extends JpaRepository<EvaluationCaptureMetadata, Long> {
    Optional<EvaluationCaptureMetadata> findByEvaluationRequestId(Long evaluationRequestId);

    @Query("select metadata.finalUrl from EvaluationCaptureMetadata metadata where metadata.evaluationRequest.id = :requestId")
    Optional<String> findFinalUrlByRequestId(@Param("requestId") Long requestId);
}
