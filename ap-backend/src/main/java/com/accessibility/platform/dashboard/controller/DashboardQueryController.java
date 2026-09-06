package com.accessibility.platform.dashboard.controller;

import com.accessibility.platform.common.response.ApiResponse;
import com.accessibility.platform.dashboard.dto.DashboardOverviewResponse;
import com.accessibility.platform.dashboard.service.DashboardQueryService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/dashboard")
public class DashboardQueryController {

    private final DashboardQueryService dashboardQueryService;

    @GetMapping("/overview")
    public ApiResponse<DashboardOverviewResponse> getOverview() {
        return ApiResponse.ok(dashboardQueryService.getOverview());
    }
}
