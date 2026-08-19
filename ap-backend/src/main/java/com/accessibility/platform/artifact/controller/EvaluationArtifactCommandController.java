package com.accessibility.platform.artifact.controller;

import com.accessibility.platform.artifact.dto.EvaluationArtifactMetadataRequest;
import com.accessibility.platform.artifact.dto.EvaluationArtifactResponse;
import com.accessibility.platform.artifact.service.EvaluationArtifactService;
import com.accessibility.platform.common.response.ApiResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/v1/evaluations")
public class EvaluationArtifactCommandController {

    private final EvaluationArtifactService artifactService;

    @PostMapping(value = "/{requestId}/artifact", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<EvaluationArtifactResponse> replaceArtifact(
            @PathVariable Long requestId,
            @Valid @RequestPart("metadata") EvaluationArtifactMetadataRequest metadata,
            @RequestPart("document") MultipartFile document
    ) {
        return ApiResponse.ok(artifactService.replace(requestId, metadata, document));
    }
}
