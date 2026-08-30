package com.accessibility.platform.dashboard.dto;

import com.accessibility.platform.analysis.domain.Severity;

public record DashboardIssueGroupResponse(
        String issueCode,
        String issueTitle,
        Severity severity,
        long count
) {
}
