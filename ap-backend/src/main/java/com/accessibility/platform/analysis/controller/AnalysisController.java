package com.accessibility.platform.analysis.controller;

import com.accessibility.platform.analysis.dto.AnalysisResultCreateRequest;
import com.accessibility.platform.analysis.dto.AnalysisResultResponse;
import com.accessibility.platform.analysis.dto.IssueResultCreateRequest;
import com.accessibility.platform.analysis.dto.IssueResultResponse;
import com.accessibility.platform.analysis.service.AnalysisService;
import com.accessibility.platform.common.response.ApiResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/analysis")
public class AnalysisController {

    private final AnalysisService analysisService;

    @PostMapping("/results")
    public ApiResponse<AnalysisResultResponse> createAnalysisResult(@Valid @RequestBody AnalysisResultCreateRequest request) {
        return ApiResponse.ok(analysisService.createAnalysisResult(request));
    }

    @PostMapping("/issues")
    public ApiResponse<IssueResultResponse> createIssueResult(@Valid @RequestBody IssueResultCreateRequest request) {
        return ApiResponse.ok(analysisService.createIssueResult(request));
    }

    @GetMapping("/requests/{requestId}/results")
    public ApiResponse<List<AnalysisResultResponse>> getAnalysisResults(@PathVariable Long requestId) {
        return ApiResponse.ok(analysisService.findAnalysisResultsByRequestId(requestId));
    }

    @GetMapping("/results/{analysisId}/issues")
    public ApiResponse<List<IssueResultResponse>> getIssueResults(@PathVariable Long analysisId) {
        return ApiResponse.ok(analysisService.findIssueResultsByAnalysisId(analysisId));
    }
}
