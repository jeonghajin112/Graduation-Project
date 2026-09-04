import { useEffect, useMemo, useState } from "react";

import type {
  AnalysisResult,
  EvaluationCaptureMetadata,
  EvaluationResultSummary,
  EvaluationRequestModel,
  EvaluationTargetModel,
  IssueResultModel,
  ScoreResult
} from "@/types/accessibility-domain";

import { selectLatestEvaluationRequest } from "../shared/evaluation-request-selection";
import { AnalysisTrendPanel } from "./site-dashboard/analysis-trend-panel";
import { severityChartItems } from "./site-dashboard/constants";
import { PageInformationPanel } from "./site-dashboard/page-information-panel";
import { RenderedPageEvidenceCard } from "./site-dashboard/rendered-page-evidence-card";
import { SeverityDistributionPanel } from "./site-dashboard/severity-distribution-panel";
import type { RecentIssueRow } from "./site-dashboard/types";
import { UnavailableLocatorPanel } from "./site-dashboard/unavailable-locator-panel";
import { useEvaluationCaptureMetadata } from "./site-dashboard/use-evaluation-capture-metadata";
import { useEvaluationResultDetails } from "./site-dashboard/use-evaluation-result-details";
import { useLiveReportSession } from "./site-dashboard/use-live-report-session";

type SiteDashboardPanelProps = {
  evaluationTarget: EvaluationTargetModel;
  evaluationRequests: EvaluationRequestModel[];
  resultSummaries: EvaluationResultSummary[];
  scoreResults: ScoreResult[];
  previewEvidence?: SiteDashboardPreviewEvidence;
};

export type SiteDashboardPreviewEvidence = {
  analysisResults: AnalysisResult[];
  captureMetadata: EvaluationCaptureMetadata | null;
  issueResults: IssueResultModel[];
  previewRuntimeUrl: string;
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
    captureMetadata,
    retry: retryCaptureMetadata
  } = useEvaluationCaptureMetadata(
    latestMaterializedResultRequest,
    previewEvidence
      ? { captureMetadata: previewEvidence.captureMetadata }
      : undefined
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
  const [selectedIssueFocusRequestId, setSelectedIssueFocusRequestId] = useState(0);
  const [unavailableLocatorIssueIds, setUnavailableLocatorIssueIds] = useState<number[]>([]);
  const [recoverableHiddenLocatorIssueIds, setRecoverableHiddenLocatorIssueIds] = useState<number[]>([]);
  const latestIssueSignature = latestIssues.map((issue) => issue.id).join(",");

  function revealHiddenIssue(issueId: number) {
    setSelectedIssueId(issueId);
    setSelectedIssueFocusRequestId((current) => current + 1);
  }

  useEffect(() => {
    setUnavailableLocatorIssueIds([]);
    setRecoverableHiddenLocatorIssueIds([]);
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
          analyzerType
        };
      }),
    [analysisResultById, latestIssues]
  );
  const unavailableLocatorIssueRows = useMemo(() => {
    const unavailableIssueIds = new Set(unavailableLocatorIssueIds);
    return replayIssueRows.filter(({ issue }) => unavailableIssueIds.has(issue.id));
  }, [replayIssueRows, unavailableLocatorIssueIds]);
  const recoverableHiddenLocatorIssueRows = useMemo(() => {
    const hiddenIssueIds = new Set(recoverableHiddenLocatorIssueIds);
    return replayIssueRows.filter(({ issue }) => hiddenIssueIds.has(issue.id));
  }, [recoverableHiddenLocatorIssueIds, replayIssueRows]);
  const evidenceLiveSessionLoadState =
    previewEvidence !== undefined
      ? "idle"
      : resultDetailsLoadState === "ready"
        ? liveSessionLoadState
        : resultDetailsLoadState === "error"
          ? "error"
          : latestResultRequestId === null
            ? "idle"
            : "loading";
  const retryEvidence = () => {
    if (resultDetailsLoadState === "error") {
      retryResultDetails();
      return;
    }
    retryLiveSession();
    retryCaptureMetadata();
  };
  // Severity comes from the result-details request and remains independent of
  // whether the current live page can still resolve every historical locator.
  const showsRailDetailCards = resultDetailsLoadState === "ready";
  const latestAnalyzedAt =
    captureMetadata?.capturedAt ??
    latestMaterializedResultRequest?.requestedAt ??
    latestMaterializedResultRequest?.updatedAt ??
    null;

  return (
    <div className="site-dashboard-layout grid min-h-[31rem] grid-cols-1 items-stretch">
      <div className="site-page-evidence-grid-item">
        <RenderedPageEvidenceCard
          captureMetadata={captureMetadata}
          errorMessage={resultDetailsErrorMessage ?? liveSessionErrorMessage}
          evaluationRequestId={latestResultRequestId}
          liveSession={liveSession}
          liveSessionLoadState={evidenceLiveSessionLoadState}
          previewRuntimeUrl={previewEvidence?.previewRuntimeUrl}
          rows={replayIssueRows}
          selectedIssueId={selectedIssueId}
          selectedIssueFocusRequestId={selectedIssueFocusRequestId}
          targetName={evaluationTarget.name}
          onRetry={retryEvidence}
          onRetryLiveSession={retryLiveSession}
          onRecoverableHiddenLocatorIssueIdsChange={setRecoverableHiddenLocatorIssueIds}
          onSelectIssue={setSelectedIssueId}
          onUnavailableLocatorIssueIdsChange={setUnavailableLocatorIssueIds}
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
          <>
            <SeverityDistributionPanel issues={latestIssues} />
            <UnavailableLocatorPanel
              mode="recoverable"
              rows={recoverableHiddenLocatorIssueRows}
              onSelectIssue={revealHiddenIssue}
            />
            <UnavailableLocatorPanel rows={unavailableLocatorIssueRows} />
          </>
        )}
      </div>
    </div>
  );
}
