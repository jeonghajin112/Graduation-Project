package com.accessibility.platform.guide.controller;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.guide.dto.ImprovementGuideCreateRequest;
import com.accessibility.platform.guide.dto.ImprovementGuideResponse;
import com.accessibility.platform.guide.service.ImprovementGuideService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/guides")
public class ImprovementGuideController {

    private final ImprovementGuideService improvementGuideService;

    @PostMapping
    public ApiResponse<ImprovementGuideResponse> createGuide(@Valid @RequestBody ImprovementGuideCreateRequest request) {
        return ApiResponse.ok(improvementGuideService.createGuide(request));
    }

    @GetMapping("/issues/{issueId}")
    public ApiResponse<ImprovementGuideResponse> getGuideByIssue(@PathVariable Long issueId) {
        return ApiResponse.ok(improvementGuideService.findByIssueId(issueId));
    }
}
