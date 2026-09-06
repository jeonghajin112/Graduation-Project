import { useCallback, useEffect, useMemo, useState } from "react";

import { getApiErrorMessage, isAbortError } from "@/services/backend-api";
import { clearSiteCreateRecovery, readSiteCreateRecovery } from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
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
import { useMutationOperation } from "../shared/use-mutation-operation";
import { QuickAnalysisProgress } from "./quick-analysis-progress";
import { AnalysisTrendPanel } from "./site-dashboard/analysis-trend-panel";
import { severityChartItems } from "./site-dashboard/constants";
import { IssueLocationDialog } from "./site-dashboard/issue-location-dialog";
import { PageInformationPanel } from "./site-dashboard/page-information-panel";
import { RenderedPageEvidenceCard } from "./site-dashboard/rendered-page-evidence-card";
import { SeverityDistributionPanel } from "./site-dashboard/severity-distribution-panel";
import type { LocatorReport, RecentIssueRow } from "./site-dashboard/types";
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
  onRequestEvaluationTargetAnalysis?: (targetId: number, signal?: AbortSignal) => Promise<number>;
  onAnalysisAccepted?: (request: EvaluationRequestModel) => void;
};

export type SiteDashboardPreviewEvidence = {
  analysisResults: AnalysisResult[];
  captureMetadata: EvaluationCaptureMetadata | null;
  issueResults: IssueResultModel[];
  previewRuntimeUrl: string;
};

export function SiteDashboardPanel(props: SiteDashboardPanelProps) {
  const requests = props.evaluationRequests.filter(
    (request) => request.evaluationTargetId === props.evaluationTarget.id
  );
  const running = requests.find((request) => request.status === "IN_PROGRESS");
  const queued = requests.find((request) => request.status === "PENDING");
  const latest = selectLatestEvaluationRequest(requests);
  const failedWithoutResult = latest?.status === "FAILED" &&
    !requests.some((request) => request.status === "COMPLETED");

  if (!props.previewEvidence && (running || queued || failedWithoutResult)) {
    return (
      <div className="site-analysis-progress">
        <QuickAnalysisProgress
          phase={running ? "running" : queued ? "queued" : "failed"}
          url={props.evaluationTarget.accessUrl}
          isBusy={Boolean(running || queued)}
        >
          {failedWithoutResult && !running && !queued ? (
            <p className="text-sm text-[var(--dashboard-text-muted)]">
              새 페이지 분석에서 주소를 입력해 다시 시도해 주세요.
            </p>
          ) : null}
        </QuickAnalysisProgress>
      </div>
    );
  }

  return <SiteDashboardResults key={props.evaluationTarget.id} {...props} />;
}

// Mount result hooks only after active jobs finish, including when rescanning
// a page with an older result. This also releases its live viewer while busy.
function SiteDashboardResults(props: SiteDashboardPanelProps) {
  const {
    evaluationTarget,
    evaluationRequests,
    previewEvidence,
    resultSummaries,
    scoreResults,
    onRequestEvaluationTargetAnalysis,
    onAnalysisAccepted
  } = props;
  const [isRequestingAnalysis, setIsRequestingAnalysis] = useState(false);
  const [analysisRequestError, setAnalysisRequestError] = useState<string | null>(null);
  const {
    beginMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent
  } = useMutationOperation();

  async function handleRequestAnalysis() {
    if (previewEvidence || !onRequestEvaluationTargetAnalysis || !onAnalysisAccepted) return;
    const operation = beginMutationOperation("page-rescan");
    if (!operation) return;
    setIsRequestingAnalysis(true);
    setAnalysisRequestError(null);

    try {
      const requestId = await onRequestEvaluationTargetAnalysis(evaluationTarget.id, operation.signal);
      if (!isMutationOperationCurrent(operation) || operation.signal.aborted) return;

      // Retire only this accepted request's recovery record before the progress
      // screen unmounts this component. Uncertain requests remain recoverable.
      const recovery = readSiteCreateRecovery();
      if (
        recovery.kind === "blocked" ||
        (recovery.kind === "valid" &&
          (recovery.attempt.phase !== "poll" ||
            recovery.attempt.targetId !== evaluationTarget.id ||
            recovery.attempt.requestId !== requestId ||
            !clearSiteCreateRecovery(recovery.rawValue)))
      ) {
        throw new UserFacingError(
          "분석 요청은 접수되었지만 브라우저에 작업 완료 상태를 저장하지 못했습니다. 브라우저 저장 공간과 설정을 확인한 뒤 다시 시도해 주세요."
        );
      }

      onAnalysisAccepted({
        id: requestId,
        evaluationTargetId: evaluationTarget.id,
        status: "PENDING",
        requestedAt: new Date().toISOString(),
        updatedAt: ""
      });
    } catch (error) {
      if (isAbortError(error) || !isMutationOperationCurrent(operation)) return;
      setAnalysisRequestError(getApiErrorMessage(error, "분석을 요청하지 못했습니다. 다시 시도해 주세요."));
    } finally {
      if (finishMutationOperation(operation)) setIsRequestingAnalysis(false);
    }
  }
  const targetEvaluationRequests = evaluationRequests.filter(
    (request) => request.evaluationTargetId === evaluationTarget.id
  );
  const latestResultRequest = selectLatestEvaluationRequest(
    // A status receipt can arrive before the refreshed overview's score rows.
    // Fetch the newly completed request instead of briefly replaying an old one.
    targetEvaluationRequests.filter((request) => request.status === "COMPLETED")
  );
  const latestResultRequestId = latestResultRequest?.id ?? null;
  const {
    analysisResults,
    errorMessage: resultDetailsErrorMessage,
    issueResults,
    loadState: resultDetailsLoadState,
    retry: retryResultDetails
  } = useEvaluationResultDetails(
    latestResultRequest,
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
    errorMessage: captureMetadataErrorMessage,
    loadState: captureMetadataLoadState,
    retry: retryCaptureMetadata
  } = useEvaluationCaptureMetadata(
    latestResultRequest,
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
    latestResultRequest,
    previewEvidence === undefined
  );
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const [locationIssueId, setLocationIssueId] = useState<number | null>(null);
  useEffect(() => { setLocationIssueId(null); }, [latestResultRequestId, evaluationTarget.id]);
  const [selectedIssueFocusRequestId, setSelectedIssueFocusRequestId] = useState(0);
  const [locatorReport, setLocatorReport] = useState<LocatorReport | null>(null);
  const handleLocatorReportChange = useCallback((next: LocatorReport) => {
    // Pending detail hooks may return new empty arrays on each render. Do not
    // let an equivalent child report start another parent/child update cycle.
    setLocatorReport((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, []);
  const latestIssueSignature = latestIssues.map((issue) => issue.id).join(",");
  const currentLocatorReport = locatorReport?.requestId === latestResultRequestId &&
    locatorReport.issueIdsSignature === latestIssueSignature ? locatorReport : null;
  const locatorCheckState = currentLocatorReport?.state ?? "loading";

  function revealHiddenIssue(issueId: number) {
    setSelectedIssueId(issueId);
    setSelectedIssueFocusRequestId((current) => current + 1);
  }

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
          analyzerType
        };
      }),
    [analysisResultById, latestIssues]
  );
  const unavailableLocatorIssueRows = useMemo(() => {
    const unavailableIssueIds = new Set(currentLocatorReport?.unavailableIssueIds);
    return replayIssueRows.filter(({ issue }) => unavailableIssueIds.has(issue.id));
  }, [replayIssueRows, currentLocatorReport]);
  const recoverableHiddenLocatorIssueRows = useMemo(() => {
    const hiddenIssueIds = new Set(currentLocatorReport?.recoverableHiddenIssueIds);
    return replayIssueRows.filter(({ issue }) => hiddenIssueIds.has(issue.id));
  }, [currentLocatorReport, replayIssueRows]);
  const locationRow = replayIssueRows.find(({ issue }) => issue.id === locationIssueId);
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
    latestResultRequest?.requestedAt ??
    latestResultRequest?.updatedAt ??
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
          onLocatorReportChange={handleLocatorReportChange}
          onSelectIssue={setSelectedIssueId}
        />
      </div>
      <div className="site-dashboard-rail">
        <PageInformationPanel
          isRequestingAnalysis={isRequestingAnalysis}
          analysisRequestError={analysisRequestError}
          onRequestAnalysis={!previewEvidence && onRequestEvaluationTargetAnalysis && onAnalysisAccepted
            ? handleRequestAnalysis
            : undefined}
          accessUrl={evaluationTarget.accessUrl}
          analyzedAt={latestAnalyzedAt}
          captureMetadataErrorMessage={captureMetadataErrorMessage}
          captureMetadataLoadState={captureMetadataLoadState}
          faviconUrl={evaluationTarget.faviconUrl}
          name={evaluationTarget.name}
          onRetryCaptureMetadata={retryCaptureMetadata}
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
              checkState={locatorCheckState}
              rows={recoverableHiddenLocatorIssueRows}
              onSelectIssue={revealHiddenIssue}
              onShowLocation={setLocationIssueId}
              issueStates={currentLocatorReport?.issueStates}
            />
            <UnavailableLocatorPanel
              checkState={locatorCheckState}
              hasHiddenIssues={recoverableHiddenLocatorIssueRows.length > 0}
              rows={unavailableLocatorIssueRows}
              onShowLocation={setLocationIssueId}
              issueStates={currentLocatorReport?.issueStates}
            />
          </>
        )}
      </div>
      {locationRow ? (
        <IssueLocationDialog
          row={locationRow}
          state={currentLocatorReport?.issueStates[locationRow.issue.id]}
          onClose={() => setLocationIssueId(null)}
        />
      ) : null}
    </div>
  );
}
