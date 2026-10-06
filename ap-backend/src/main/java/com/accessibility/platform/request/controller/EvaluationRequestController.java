package com.accessibility.platform.request.controller;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.request.dto.EvaluationRequestCreateRequest;
import com.accessibility.platform.request.dto.EvaluationRequestResponse;
import com.accessibility.platform.request.dto.EvaluationRequestStatusUpdateRequest;
import com.accessibility.platform.request.service.EvaluationRequestService;
import com.accessibility.platform.request.service.AnalysisSubmissionService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

import com.accessibility.platform.request.dto.EvaluateUrlRequest;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/requests")
public class EvaluationRequestController {

    private final EvaluationRequestService evaluationRequestService;
    private final AnalysisSubmissionService analysisSubmissionService;

    @PostMapping
    public ApiResponse<EvaluationRequestResponse> create(@Valid @RequestBody EvaluationRequestCreateRequest request,
            @RequestHeader(name = "Idempotency-Key", required = false) String key) {
        return ApiResponse.ok(analysisSubmissionService.create(request, key));
    }

    @PostMapping("/evaluate")
    public ApiResponse<EvaluationRequestResponse> evaluateUrl(@Valid @RequestBody EvaluateUrlRequest request,
            @RequestHeader(name = "Idempotency-Key", required = false) String key) {
        return ApiResponse.ok(analysisSubmissionService.evaluate(request, key));
    }

    @GetMapping("/attempts/{key}")
    public ApiResponse<EvaluationRequestResponse> findAttempt(@PathVariable String key) {
        return ApiResponse.ok(analysisSubmissionService.find(key));
    }

    @GetMapping("/statuses")
    public ApiResponse<List<com.accessibility.platform.request.dto.EvaluationRequestStatusEntry>> statuses(@RequestParam List<Long> ids) {
        return ApiResponse.ok(evaluationRequestService.findStatuses(ids));
    }

    @GetMapping("/active")
    public ApiResponse<List<EvaluationRequestResponse>> active(@RequestParam Long targetId) {
        return ApiResponse.ok(evaluationRequestService.findActiveForTarget(targetId));
    }

    @GetMapping
    public ApiResponse<List<EvaluationRequestResponse>> findAll() {
        return ApiResponse.ok(evaluationRequestService.findAll());
    }

    @GetMapping("/{id}")
    public ApiResponse<EvaluationRequestResponse> findById(@PathVariable Long id) {
        return ApiResponse.ok(evaluationRequestService.findById(id));
    }

    @PatchMapping("/{id}/status")
    public ApiResponse<EvaluationRequestResponse> updateStatus(
            @PathVariable Long id,
            @Valid @RequestBody EvaluationRequestStatusUpdateRequest request
    ) {
        return ApiResponse.ok(evaluationRequestService.updateStatus(id, request));
    }
}
