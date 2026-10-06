package com.accessibility.platform.capturemetadata.controller;

import com.accessibility.platform.capturemetadata.dto.EvaluationCaptureMetadataResponse;
import com.accessibility.platform.capturemetadata.service.EvaluationCaptureMetadataService;
import com.accessibility.platform.common.response.ApiResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/results")
public class EvaluationCaptureMetadataQueryController {

    private final EvaluationCaptureMetadataService metadataService;

    @GetMapping("/requests/{requestId}/capture-metadata")
    public ApiResponse<EvaluationCaptureMetadataResponse> getCaptureMetadata(@PathVariable Long requestId) {
        return ApiResponse.ok(metadataService.getByRequestId(requestId));
    }
}
