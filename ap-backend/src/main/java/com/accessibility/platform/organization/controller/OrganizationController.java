package com.accessibility.platform.organization.controller;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.organization.dto.OrganizationCreateRequest;
import com.accessibility.platform.organization.dto.OrganizationResponse;
import com.accessibility.platform.organization.dto.OrganizationUpdateRequest;
import com.accessibility.platform.organization.service.OrganizationService;
import com.accessibility.platform.target.dto.EvaluationTargetResponse;
import com.accessibility.platform.target.dto.EvaluationTargetLightRequest;
import com.accessibility.platform.target.dto.EvaluationTargetCreateRequest;
import com.accessibility.platform.target.dto.EvaluationTargetUpdateRequest;
import com.accessibility.platform.target.service.EvaluationTargetService;
import com.accessibility.platform.target.domain.TargetType;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/organizations")
public class OrganizationController {

    private final OrganizationService organizationService;
    private final EvaluationTargetService evaluationTargetService;

    @PostMapping
    public ApiResponse<OrganizationResponse> create(@Valid @RequestBody OrganizationCreateRequest request) {
        return ApiResponse.ok(organizationService.create(request));
    }

    @GetMapping
    public ApiResponse<List<OrganizationResponse>> findAll() {
        return ApiResponse.ok(organizationService.findAll());
    }

    @GetMapping("/{id}")
    public ApiResponse<OrganizationResponse> findById(@PathVariable Long id) {
        return ApiResponse.ok(organizationService.findById(id));
    }

    @PutMapping("/{id}")
    public ApiResponse<OrganizationResponse> update(
        @PathVariable Long id,
        @Valid @RequestBody OrganizationUpdateRequest request
    ) {
        return ApiResponse.ok(organizationService.update(id, request));
    }

    @PatchMapping("/{id}")
    public ApiResponse<OrganizationResponse> patch(
        @PathVariable Long id,
        @Valid @RequestBody OrganizationLightRequest requestLight
    ) {
        OrganizationUpdateRequest request = new OrganizationUpdateRequest(
                requestLight.name(),
                com.accessibility.platform.organization.domain.OrganizationType.ETC,
                null,
                requestLight.description()
        );
        return ApiResponse.ok(organizationService.update(id, request));
    }

    @PatchMapping("/{id}/deactivate")
    public ApiResponse<Void> deactivate(@PathVariable Long id) {
        organizationService.deactivate(id);
        return ApiResponse.ok(null, "기관이 비활성화되었습니다.");
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        organizationService.deactivate(id);
        return ApiResponse.ok(null, "Organization deactivated.");
    }

    @GetMapping("/{organizationId}/evaluation-targets")
    public ApiResponse<List<EvaluationTargetResponse>> findTargetsByOrganization(@PathVariable Long organizationId) {
        return ApiResponse.ok(evaluationTargetService.findByOrganizationId(organizationId));
    }

    @PostMapping("/{organizationId}/evaluation-targets")
    public ApiResponse<EvaluationTargetResponse> createTarget(
            @PathVariable Long organizationId,
            @Valid @RequestBody EvaluationTargetLightRequest requestLight
    ) {
        EvaluationTargetCreateRequest request = new EvaluationTargetCreateRequest(
                organizationId,
                requestLight.name(),
                TargetType.WEB,
                requestLight.accessUrl(),
                ""
        );
        return ApiResponse.ok(evaluationTargetService.create(request));
    }

    @PatchMapping("/{organizationId}/evaluation-targets/{targetId}")
    public ApiResponse<EvaluationTargetResponse> patchTarget(
            @PathVariable Long organizationId,
            @PathVariable Long targetId,
            @Valid @RequestBody EvaluationTargetLightRequest requestLight
    ) {
        EvaluationTargetUpdateRequest request = new EvaluationTargetUpdateRequest(
                requestLight.name(),
                TargetType.WEB,
                requestLight.accessUrl(),
                ""
        );
        return ApiResponse.ok(evaluationTargetService.update(targetId, request));
    }

    @DeleteMapping("/{organizationId}/evaluation-targets/{targetId}")
    public ApiResponse<Void> deleteTarget(
            @PathVariable Long organizationId,
            @PathVariable Long targetId
    ) {
        evaluationTargetService.deleteLogical(targetId);
        return ApiResponse.ok(null, "평가 대상이 삭제되었습니다.");
    }

    private record OrganizationLightRequest(
            @NotBlank @Size(max = 100) String name,
            @Size(max = 500) String description
    ) {
    }
}
