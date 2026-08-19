package com.accessibility.platform.request.controller;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.request.dto.EvaluationRequestCreateRequest;
import com.accessibility.platform.request.dto.EvaluationRequestResponse;
import com.accessibility.platform.request.dto.EvaluationRequestStatusUpdateRequest;
import com.accessibility.platform.request.service.EvaluationRequestService;
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

    @PostMapping
    public ApiResponse<EvaluationRequestResponse> create(@Valid @RequestBody EvaluationRequestCreateRequest request) {
        return ApiResponse.ok(evaluationRequestService.create(request));
    }

    @PostMapping("/evaluate")
    public ApiResponse<EvaluationRequestResponse> evaluateUrl(@Valid @RequestBody EvaluateUrlRequest request) {
        return ApiResponse.ok(evaluationRequestService.createForUrl(request));
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
