package com.accessibility.platform.dashboard.dto;

import java.util.List;

public record DashboardLatestIssueCountsResponse(
        Long evaluationTargetId,
        Long requestId,
        long totalIssueCount,
        long criticalIssueCount,
        long highIssueCount,
        long mediumIssueCount,
        long lowIssueCount,
        List<DashboardIssueGroupResponse> groups
) {
    public DashboardLatestIssueCountsResponse {
        groups = List.copyOf(groups);
    }
}
