import { useEffect, useMemo, useState } from "react";

import type {
  AnalyzerType,
  AnalysisResult,
  EvaluationArtifact,
  EvaluationResultSummary,
  EvaluationRequestModel,
  EvaluationTargetModel,
  IssueResultModel,
  ScoreResult
} from "@/types/accessibility-domain";

import { selectLatestEvaluationRequest } from "../shared/evaluation-request-selection";
import { AnalysisTrendPanel } from "./site-dashboard/analysis-trend-panel";
import { resolveWcagCriterion, severityChartItems } from "./site-dashboard/constants";
import { PageInformationPanel } from "./site-dashboard/page-information-panel";
import { RenderedPageEvidenceCard } from "./site-dashboard/rendered-page-evidence-card";
import { SeverityDistributionPanel } from "./site-dashboard/severity-distribution-panel";
import type { RecentIssueRow } from "./site-dashboard/types";
import { useEvaluationArtifact } from "./site-dashboard/use-evaluation-artifact";
import { useEvaluationResultDetails } from "./site-dashboard/use-evaluation-result-details";
import { useLiveReportSession } from "./site-dashboard/use-live-report-session";
import { getAnalyzerTypeLabel } from "./site-dashboard/utils";

type SiteDashboardPanelProps = {
  evaluationTarget: EvaluationTargetModel;
  evaluationRequests: EvaluationRequestModel[];
  resultSummaries: EvaluationResultSummary[];
  scoreResults: ScoreResult[];
  previewEvidence?: SiteDashboardPreviewEvidence;
};

export type SiteDashboardPreviewEvidence = {
  analysisResults: AnalysisResult[];
  artifact: EvaluationArtifact | null;
  artifactContentUrl?: string;
  issueResults: IssueResultModel[];
};

export function SiteDashboardPanel(props: SiteDashboardPanelProps) {
  const {
    evaluationTarget,
    evaluationRequests,
    previewEvidence,
    resultSummaries,
    scoreResults
  } = props;
  const targetEvaluationRequests = evaluationRequests.filter(
    (request) => request.evaluationTargetId === evaluationTarget.id
  );
  const materializedRequestIds = new Set([
    ...resultSummaries.map((summary) => summary.requestId),
    ...scoreResults.map((scoreResult) => scoreResult.evaluationRequestId)
  ]);
  const latestMaterializedResultRequest = selectLatestEvaluationRequest(
    targetEvaluationRequests,
    materializedRequestIds
  );
  const latestResultRequestId = latestMaterializedResultRequest?.id ?? null;
  const {
    analysisResults,
    errorMessage: resultDetailsErrorMessage,
    issueResults,
    loadState: resultDetailsLoadState,
    retry: retryResultDetails
  } = useEvaluationResultDetails(
    latestMaterializedResultRequest,
    previewEvidence
      ? {
          analysisResults: previewEvidence.analysisResults,
          issueResults: previewEvidence.issueResults
        }
      : undefined
  );
  const requestIdByAnalysisResultId = useMemo(
    () =>
      new Map(
        analysisResults.map((analysisResult) => [
          analysisResult.id,
          analysisResult.evaluationRequestId
        ])
      ),
    [analysisResults]
  );
  const analysisResultById = useMemo(
    () => new Map(analysisResults.map((analysisResult) => [analysisResult.id, analysisResult])),
    [analysisResults]
  );
  const latestIssues = useMemo(
    () =>
      latestResultRequestId === null
        ? []
        : issueResults.filter(
            (issue) => requestIdByAnalysisResultId.get(issue.analysisResultId) === latestResultRequestId
          ),
    [issueResults, latestResultRequestId, requestIdByAnalysisResultId]
  );
  const {
    artifact,
    errorMessage: artifactErrorMessage,
    loadState: artifactLoadState,
    retry: retryArtifact
  } = useEvaluationArtifact(
    latestMaterializedResultRequest,
    previewEvidence ? { artifact: previewEvidence.artifact } : undefined
  );
  const {
    errorMessage: liveSessionErrorMessage,
    loadState: liveSessionLoadState,
    retry: retryLiveSession,
    session: liveSession
  } = useLiveReportSession(
    latestMaterializedResultRequest,
    previewEvidence === undefined
  );
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const latestIssueSignature = latestIssues.map((issue) => issue.id).join(",");

  useEffect(() => {
    setSelectedIssueId((current) => {
      if (current !== null && latestIssues.some((issue) => issue.id === current)) {
        return current;
      }

      // Markers should start in their neutral state. A target is highlighted
      // only after the user hovers, focuses, or explicitly selects its marker.
      return null;
    });
  }, [latestIssueSignature, latestResultRequestId]);

  const replayIssueRows = useMemo<RecentIssueRow[]>(
    () =>
      latestIssues.map((issue) => {
        const severity = severityChartItems.find((item) => item.key === issue.severity) ?? severityChartItems[0]!;
        const analyzerType = analysisResultById.get(issue.analysisResultId)?.analyzerType;
        return {
          issue,
          severity,
          wcagCriterion: resolveWcagCriterion(issue.issueCode, issue.issueTitle),
          issueGuides: [],
          analyzerLabel: getAnalyzerTypeLabel(analyzerType),
          analyzerType,
          showsAiGuide: isTextAccessibilityIssue(issue, analyzerType)
        };
      }),
    [analysisResultById, latestIssues]
  );
  const evidenceLoadState =
    resultDetailsLoadState === "loading"
      ? "loading"
      : resultDetailsLoadState === "error"
        ? "error"
        : artifactLoadState;
  const evidenceErrorMessage =
    resultDetailsErrorMessage ?? artifactErrorMessage ?? liveSessionErrorMessage;
  const evidenceLiveSessionLoadState =
    resultDetailsLoadState === "ready" ? liveSessionLoadState : "idle";
  const retryEvidence = () => {
    if (resultDetailsLoadState === "error") {
      retryResultDetails();
      return;
    }
    retryLiveSession();
    retryArtifact();
  };
  // Severity comes from the result-details request, not from the replay
  // artifact. Keep it available when only the DOM replay is missing or is
  // still being reconciled.
  const showsRailDetailCards = resultDetailsLoadState === "ready";
  const latestAnalyzedAt =
    artifact?.capturedAt ??
    latestMaterializedResultRequest?.requestedAt ??
    latestMaterializedResultRequest?.updatedAt ??
    null;

  return (
    <div className="site-dashboard-layout grid min-h-[31rem] grid-cols-1 items-stretch">
      <div className="site-page-evidence-grid-item">
        <RenderedPageEvidenceCard
          artifact={artifact}
          artifactContentUrl={previewEvidence?.artifactContentUrl}
          errorMessage={evidenceErrorMessage}
          evaluationRequestId={latestResultRequestId}
          liveSession={liveSession}
          liveSessionErrorMessage={liveSessionErrorMessage}
          liveSessionLoadState={evidenceLiveSessionLoadState}
          loadState={evidenceLoadState}
          rows={replayIssueRows}
          selectedIssueId={selectedIssueId}
          targetName={evaluationTarget.name}
          onRetry={retryEvidence}
          onRetryLiveSession={retryLiveSession}
          onSelectIssue={setSelectedIssueId}
        />
      </div>
      <div className="site-dashboard-rail">
        <PageInformationPanel
          accessUrl={evaluationTarget.accessUrl}
          analyzedAt={latestAnalyzedAt}
          faviconUrl={evaluationTarget.faviconUrl}
          name={evaluationTarget.name}
        />

        <AnalysisTrendPanel
          evaluationRequests={evaluationRequests}
          evaluationTargetId={evaluationTarget.id}
          resultSummaries={resultSummaries}
          scoreResults={scoreResults}
        />

        {showsRailDetailCards && (
          <SeverityDistributionPanel issues={latestIssues} />
        )}
      </div>
    </div>
  );
}

function isTextAccessibilityIssue(issue: IssueResultModel, analyzerType?: AnalyzerType): boolean {
  if (analyzerType !== "AI_TEXT") {
    return false;
  }

  const searchableText = [issue.issueCode, issue.issueTitle, issue.message].join(" ").toLowerCase();
  return (
    searchableText.includes("text") ||
    searchableText.includes("difficulty") ||
    searchableText.includes("텍스트") ||
    searchableText.includes("난이도")
  );
}
