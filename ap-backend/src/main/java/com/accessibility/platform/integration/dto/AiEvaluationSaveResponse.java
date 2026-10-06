package com.accessibility.platform.integration.dto;

import com.accessibility.platform.request.domain.EvaluationRequestStatus;

import java.math.BigDecimal;

public record AiEvaluationSaveResponse(
        Long evaluation_id,
        String status,
        Long evaluation_request_id,
        Long evaluation_target_id,
        BigDecimal total_score,
        String grade,
        EvaluationRequestStatus request_status
) {
}
