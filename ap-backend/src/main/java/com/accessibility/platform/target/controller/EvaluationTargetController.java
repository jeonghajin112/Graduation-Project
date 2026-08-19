package com.accessibility.platform.target.controller;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.target.dto.EvaluationTargetCreateRequest;
import com.accessibility.platform.target.dto.EvaluationTargetResponse;
import com.accessibility.platform.target.dto.EvaluationTargetUpdateRequest;
import com.accessibility.platform.target.service.EvaluationTargetService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/targets")
public class EvaluationTargetController {

    private final EvaluationTargetService evaluationTargetService;

    @PostMapping
    public ApiResponse<EvaluationTargetResponse> create(@Valid @RequestBody EvaluationTargetCreateRequest request) {
        return ApiResponse.ok(evaluationTargetService.create(request));
    }

    @GetMapping
    public ApiResponse<List<EvaluationTargetResponse>> findAll(
            @RequestParam(required = false) Long organizationId
    ) {
        if (organizationId != null) {
            return ApiResponse.ok(evaluationTargetService.findByOrganizationId(organizationId));
        }
        return ApiResponse.ok(evaluationTargetService.findAll());
    }

    @GetMapping("/{id}")
    public ApiResponse<EvaluationTargetResponse> findById(@PathVariable Long id) {
        return ApiResponse.ok(evaluationTargetService.findById(id));
    }

    @PutMapping("/{id}")
    public ApiResponse<EvaluationTargetResponse> update(
            @PathVariable Long id,
            @Valid @RequestBody EvaluationTargetUpdateRequest request
    ) {
        return ApiResponse.ok(evaluationTargetService.update(id, request));
    }

    @PatchMapping("/{id}/deactivate")
    public ApiResponse<Void> deactivate(@PathVariable Long id) {
        evaluationTargetService.deactivate(id);
        return ApiResponse.ok(null, "평가 대상이 비활성화되었습니다.");
    }

    @PatchMapping("/{id}/delete")
    public ApiResponse<Void> deleteLogical(@PathVariable Long id) {
        evaluationTargetService.deleteLogical(id);
        return ApiResponse.ok(null, "평가 대상이 논리 삭제되었습니다.");
    }
}
