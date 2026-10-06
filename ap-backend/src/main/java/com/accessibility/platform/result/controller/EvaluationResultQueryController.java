package com.accessibility.platform.result.controller;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.result.dto.EvaluationIssueResponse;
import com.accessibility.platform.result.dto.EvaluationResultSummaryResponse;
import com.accessibility.platform.result.service.EvaluationResultQueryService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/results")
public class EvaluationResultQueryController {

    private final EvaluationResultQueryService evaluationResultQueryService;

    @GetMapping("/requests/{requestId}/summary")
    public ApiResponse<EvaluationResultSummaryResponse> getSummary(@PathVariable Long requestId) {
        return ApiResponse.ok(evaluationResultQueryService.getSummary(requestId));
    }

    @GetMapping("/requests/{requestId}/issues")
    public ApiResponse<List<EvaluationIssueResponse>> getIssues(@PathVariable Long requestId) {
        return ApiResponse.ok(evaluationResultQueryService.getIssues(requestId));
    }
}
