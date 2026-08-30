package com.accessibility.platform.dashboard.dto;

import com.accessibility.platform.request.dto.EvaluationRequestResponse;
import com.accessibility.platform.result.dto.EvaluationResultSummaryResponse;

import java.util.List;

public record DashboardOverviewResponse(
        List<DashboardOrganizationResponse> organizations,
        List<EvaluationRequestResponse> evaluationRequests,
        List<EvaluationResultSummaryResponse> resultSummaries,
        List<DashboardScoreResponse> scoreResults,
        List<DashboardLatestIssueCountsResponse> latestIssueCounts
) {
    public DashboardOverviewResponse {
        organizations = List.copyOf(organizations);
        evaluationRequests = List.copyOf(evaluationRequests);
        resultSummaries = List.copyOf(resultSummaries);
        scoreResults = List.copyOf(scoreResults);
        latestIssueCounts = List.copyOf(latestIssueCounts);
    }
}
