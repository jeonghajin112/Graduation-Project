package com.accessibility.platform.artifact.controller;

import com.accessibility.platform.artifact.dto.EvaluationArtifactResponse;
import com.accessibility.platform.artifact.service.EvaluationArtifactService;
import com.accessibility.platform.artifact.service.ReplayDocumentSanitizer;
import com.accessibility.platform.common.response.ApiResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/results")
public class EvaluationArtifactQueryController {

    private final EvaluationArtifactService artifactService;
    private final ReplayDocumentSanitizer replayDocumentSanitizer;

    @GetMapping("/requests/{requestId}/artifact")
    public ApiResponse<EvaluationArtifactResponse> getArtifact(@PathVariable Long requestId) {
        return ApiResponse.ok(artifactService.getByRequestId(requestId));
    }

    @GetMapping("/artifacts/{artifactId}/content")
    public ResponseEntity<org.springframework.core.io.Resource> getArtifactContent(@PathVariable Long artifactId) {
        EvaluationArtifactService.ArtifactContent content = artifactService.getContent(artifactId);
        return ResponseEntity.ok()
                .contentType(new MediaType("text", "html", StandardCharsets.UTF_8))
                .contentLength(content.sizeBytes())
                .cacheControl(CacheControl.noStore())
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"replay.html\"")
                .header("X-Content-Type-Options", "nosniff")
                .header("Referrer-Policy", "no-referrer")
                .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
                .header("Content-Security-Policy", replayContentSecurityPolicy())
                .body(content.resource());
    }

    private String replayContentSecurityPolicy() {
        return "default-src 'none'; "
                + "base-uri http: https:; "
                + "script-src " + replayDocumentSanitizer.bridgeScriptCspSource() + "; "
                + "style-src 'unsafe-inline' http: https: data:; "
                + "img-src http: https: data: blob:; "
                + "font-src http: https: data:; "
                + "media-src http: https: data: blob:; "
                + "connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; "
                + "worker-src 'none'; manifest-src 'none'; form-action 'none'; "
                + "sandbox allow-scripts";
    }
}
