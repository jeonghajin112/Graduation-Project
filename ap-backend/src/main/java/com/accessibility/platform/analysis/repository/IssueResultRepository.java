package com.accessibility.platform.analysis.repository;

import com.accessibility.platform.analysis.domain.IssueResult;
import com.accessibility.platform.analysis.domain.AnalyzerType;
import com.accessibility.platform.analysis.domain.Severity;
import com.accessibility.platform.organization.domain.OrganizationStatus;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.target.domain.TargetStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface IssueResultRepository extends JpaRepository<IssueResult, Long> {
    List<IssueResult> findByAnalysisResultId(Long analysisResultId);

    @Query("""
            select issue
            from IssueResult issue
            join fetch issue.analysisResult analysisResult
            where issue.issueCode = :legacyTextCode
               or (analysisResult.analyzerType = :cvAnalyzerType and issue.issueCode = :legacyCvCode)
            order by issue.id asc
            """)
    List<IssueResult> findStandardMigrationCandidates(
            @Param("legacyTextCode") String legacyTextCode,
            @Param("cvAnalyzerType") AnalyzerType cvAnalyzerType,
            @Param("legacyCvCode") String legacyCvCode
    );

    interface RequestSeverityCountProjection {
        Long getRequestId();
        Severity getSeverity();
        long getIssueCount();
    }

    interface RequestIssueGroupProjection {
        Long getRequestId();
        String getIssueCode();
        String getIssueTitle();
        Severity getSeverity();
        long getIssueCount();
    }

    interface RequestIssueSummaryProjection {
        long getTotalIssueCount();
        long getCriticalIssueCount();
    }

    @Query("""
            select count(issue.id) as totalIssueCount,
                   coalesce(sum(case when issue.severity = :criticalSeverity then 1 else 0 end), 0)
                       as criticalIssueCount
            from IssueResult issue
            join issue.analysisResult analysisResult
            where analysisResult.evaluationRequest.id = :requestId
            """)
    RequestIssueSummaryProjection summarizeRequestIssues(
            @Param("requestId") Long requestId,
            @Param("criticalSeverity") Severity criticalSeverity
    );

    @Query("""
            select analysisResult.evaluationRequest.id as requestId,
                   issue.severity as severity,
                   count(issue.id) as issueCount
            from IssueResult issue
            join issue.analysisResult analysisResult
            join analysisResult.evaluationRequest evaluationRequest
            join evaluationRequest.evaluationTarget target
            join target.organization organization
            where organization.status = :organizationStatus
              and target.status = :targetStatus
              and evaluationRequest.status = :requestStatus
            group by analysisResult.evaluationRequest.id, issue.severity
            """)
    List<RequestSeverityCountProjection> findDashboardSeverityCounts(
            @Param("organizationStatus") OrganizationStatus organizationStatus,
            @Param("targetStatus") TargetStatus targetStatus,
            @Param("requestStatus") EvaluationRequestStatus requestStatus
    );

    @Query("""
            select analysisResult.evaluationRequest.id as requestId,
                   issue.issueCode as issueCode,
                   issue.issueTitle as issueTitle,
                   issue.severity as severity,
                   count(issue.id) as issueCount
            from IssueResult issue
            join issue.analysisResult analysisResult
            where analysisResult.evaluationRequest.id in :requestIds
            group by analysisResult.evaluationRequest.id,
                     issue.issueCode,
                     issue.issueTitle,
                     issue.severity
            order by analysisResult.evaluationRequest.id asc,
                     count(issue.id) desc,
                     issue.issueCode asc,
                     issue.issueTitle asc,
                     issue.severity asc
            """)
    List<RequestIssueGroupProjection> findDashboardIssueGroups(
            @Param("requestIds") List<Long> requestIds
    );

    @Query("""
            select issue
            from IssueResult issue
            join fetch issue.analysisResult analysisResult
            where analysisResult.evaluationRequest.id = :requestId
            order by issue.createdAt asc, issue.id asc
            """)
    List<IssueResult> findIssueDetailsByRequestId(@Param("requestId") Long requestId);
}
