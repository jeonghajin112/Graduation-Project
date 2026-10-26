import { retireAcceptedTargetAnalysis } from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ErrorBoundary, isLazyChunkLoadError } from "@/components/shared/error-boundary";
import { ModalErrorFallback, ModalLoadFallback } from "../shared/modal-load-fallback";
import { RoutePanelErrorFallback, RoutePanelFallback } from "../shared/route-panel-fallbacks";

import { getApiErrorMessage, isAbortError } from "@/services/backend-api";
import type {
  AnalysisResult,
  EvaluationCaptureMetadata,
  EvaluationResultSummary,
  EvaluationRequestModel,
  EvaluationTargetModel,
  IssueResultModel,
  ScoreResult
} from "@/types/accessibility-domain";

import { selectLatestAnalysisAttempt, selectLatestEvaluationRequest } from "@/services/evaluation-request-selection";
import { formatDateTime } from "../shared/utils";
import { useMutationOperation } from "../shared/use-mutation-operation";
import { QuickAnalysisProgress, type AnalysisPhase } from "./quick-analysis-progress";
import { AnalysisTrendPanel } from "./site-dashboard/analysis-trend-panel";
import { severityChartItems } from "./site-dashboard/constants";
import {
  DashboardViewTabs,
  parseDashboardView,
  type DashboardView
} from "./site-dashboard/dashboard-view-tabs";
import { PageAnalysisActions } from "./site-dashboard/page-analysis-actions";
import { RenderedPageEvidenceCard } from "./site-dashboard/rendered-page-evidence-card";
import { SeverityDistributionPanel } from "./site-dashboard/severity-distribution-panel";
import type { LocatorCheckState, LocatorReport, RecentIssueRow } from "./site-dashboard/types";
import { useEvaluationCaptureMetadata, type EvaluationCaptureMetadataLoadState } from "./site-dashboard/use-evaluation-capture-metadata";
import { useEvaluationResultDetails, type EvaluationResultDetailsLoadState } from "./site-dashboard/use-evaluation-result-details";
import { useLiveReportSession, type LiveReportSessionLoadState } from "./site-dashboard/use-live-report-session";
import { sameLocatorReport } from "./site-dashboard/locator-report";

import "@/styles/page-evidence-layout.css";

const IssueLocationDialog = lazy(() => import("./site-dashboard/issue-location-dialog")
  .then(module => ({ default: module.IssueLocationDialog })));
const FinalReportPanel = lazy(() => import("./site-dashboard/final-report-panel")
  .then(module => ({ default: module.FinalReportPanel })));
// The location lists fill in only after the live page reports positions.
const UnavailableLocatorPanel = lazy(() => import("./site-dashboard/unavailable-locator-panel")
  .then(module => ({ default: module.UnavailableLocatorPanel })));

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

function selectProgressPhase(requests: EvaluationRequestModel[]): AnalysisPhase | null {
  const running = requests.find((request) => request.status === "IN_PROGRESS");
  const queued = requests.find((request) => request.status === "PENDING");
  const latest = selectLatestAnalysisAttempt(requests);
  const failedWithoutResult = latest?.status === "FAILED" &&
    !requests.some((request) => request.status === "COMPLETED");
  if (running) return "running";
  if (queued) return "queued";
  return failedWithoutResult ? "failed" : null;
}

export function SiteDashboardPanel(props: SiteDashboardPanelProps) {
  const requests = props.evaluationRequests.filter(
    (request) => request.evaluationTargetId === props.evaluationTarget.id
  );
  const phase = selectProgressPhase(requests);

  if (!props.previewEvidence && phase) {
    return (
      <div className="site-analysis-progress">
        <QuickAnalysisProgress
          phase={phase}
          url={props.evaluationTarget.accessUrl}
          isBusy={phase !== "failed"}
        >
          {phase === "failed" ? (
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

// The page view and the report share one re-analysis request. The preview and
// a parent that cannot accept the request offer none.
function usePageRescanRequest({
  evaluationTarget,
  previewEvidence,
  onRequestEvaluationTargetAnalysis,
  onAnalysisAccepted
}: SiteDashboardPanelProps) {
  const [isRequestingAnalysis, setIsRequestingAnalysis] = useState(false);
  const [analysisRequestError, setAnalysisRequestError] = useState<string | null>(null);
  const {
    beginMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent
  } = useMutationOperation();
  const canRequestAnalysis = !previewEvidence && onRequestEvaluationTargetAnalysis && onAnalysisAccepted;

  async function handleRequestAnalysis() {
    if (!canRequestAnalysis) return;
    const operation = beginMutationOperation("page-rescan");
    if (!operation) return;
    setIsRequestingAnalysis(true);
    setAnalysisRequestError(null);

    try {
      const requestId = await onRequestEvaluationTargetAnalysis(evaluationTarget.id, operation.signal);
      if (!isMutationOperationCurrent(operation) || operation.signal.aborted) return;

      // Retire only this accepted request's recovery record before the progress
      // screen unmounts this component. Unrelated work stays recoverable.
      if (!retireAcceptedTargetAnalysis(evaluationTarget.id, requestId)) {
        throw new UserFacingError(
          "분석 요청은 접수되었지만 브라우저에 작업 완료 상태를 저장하지 못했습니다. 브라우저 저장 공간과 설정을 확인한 뒤 다시 시도해 주세요."
        );
      }

      onAnalysisAccepted({
        id: requestId,
        evaluationTargetId: evaluationTarget.id,
        status: "PENDING",
        // Unknown until the server row arrives; ordering then uses the request ID
        // instead of this browser's clock or time zone.
        requestedAt: "",
        updatedAt: ""
      });
    } catch (error) {
      if (isAbortError(error) || !isMutationOperationCurrent(operation)) return;
      setAnalysisRequestError(getApiErrorMessage(error, "분석을 요청하지 못했습니다. 다시 시도해 주세요."));
    } finally {
      if (finishMutationOperation(operation)) setIsRequestingAnalysis(false);
    }
  }

  return {
    isRequestingAnalysis,
    analysisRequestError,
    onRequestAnalysis: canRequestAnalysis ? handleRequestAnalysis : undefined
  };
}

function selectResultRequests(requests: EvaluationRequestModel[], previewEvidence?: SiteDashboardPreviewEvidence) {
  const latestResultRequest = selectLatestEvaluationRequest(
    // A status receipt can arrive before the refreshed overview's score rows.
    // Fetch the newly completed request instead of briefly replaying an old one.
    requests.filter((request) => request.status === "COMPLETED")
  );
  const latestAttempt = selectLatestAnalysisAttempt(requests);
  return {
    latestResultRequest,
    latestResultRequestId: latestResultRequest?.id ?? null,
    showsPreviousResult: !previewEvidence && latestAttempt?.status === "FAILED" && latestResultRequest !== null
  };
}

function readLocatorReport(report: LocatorReport | null, requestId: number | null, issueIdsSignature: string) {
  const currentLocatorReport = report?.requestId === requestId &&
    report.issueIdsSignature === issueIdsSignature ? report : null;
  const locatorCheckState: LocatorCheckState = currentLocatorReport?.state ?? "loading";
  return { currentLocatorReport, locatorCheckState, issueStates: currentLocatorReport?.issueStates };
}

function evidenceLiveSessionLoadStateOf(
  hasPreview: boolean,
  resultDetailsLoadState: EvaluationResultDetailsLoadState,
  liveSessionLoadState: LiveReportSessionLoadState,
  latestResultRequestId: number | null
): LiveReportSessionLoadState {
  return hasPreview
    ? "idle"
    : resultDetailsLoadState === "ready"
      ? liveSessionLoadState
      : resultDetailsLoadState === "error"
        ? "error"
        : latestResultRequestId === null
          ? "idle"
          : "loading";
}

function readCapture(captureMetadata: EvaluationCaptureMetadata | null, latestResultRequest: EvaluationRequestModel | null) {
  return {
    deviceScaleFactor: captureMetadata?.deviceScaleFactor ?? null,
    analyzedAt: captureMetadata?.capturedAt ??
      latestResultRequest?.requestedAt ??
      latestResultRequest?.updatedAt ??
      null
  };
}

function ResultNotices({
  showsPreviousResult,
  analyzedAt,
  analysisRequestError,
  captureMetadataLoadState,
  captureMetadataErrorMessage,
  onRetryCaptureMetadata
}: {
  showsPreviousResult: boolean;
  analyzedAt: string | null;
  analysisRequestError: string | null;
  captureMetadataLoadState: EvaluationCaptureMetadataLoadState;
  captureMetadataErrorMessage: string | null;
  onRetryCaptureMetadata: () => void;
}) {
  if (!(showsPreviousResult || analysisRequestError || captureMetadataLoadState === "loading" || captureMetadataLoadState === "error")) {
    return null;
  }
  return (
    <div className="site-result-notices">
      {showsPreviousResult && <p className="site-result-notice" role="status">
        최신 재분석에 실패했습니다. {formatDateTime(analyzedAt)} 분석의 이전 성공 결과를 표시하고 있습니다.
      </p>}
      {analysisRequestError && (
        <p id="site-analysis-request-error" className="site-result-notice" role="alert">
          {analysisRequestError}
        </p>
      )}
      {captureMetadataLoadState === "loading" && (
        <p className="site-capture-metadata-status site-result-notice" role="status">
          분석 당시 화면 정보를 불러오는 중입니다.
        </p>
      )}
      {captureMetadataLoadState === "error" && (
        <div className="site-capture-metadata-status site-result-notice" role="alert">
          <p>분석 당시 화면 정보를 불러오지 못했습니다.</p>
          {captureMetadataErrorMessage && <p>{captureMetadataErrorMessage}</p>}
          <button type="button" onClick={onRetryCaptureMetadata}>
            화면 정보 다시 불러오기
          </button>
        </div>
      )}
    </div>
  );
}

// Mount result hooks only after active jobs finish, including when rescanning
// a page with an older result. This also releases its live viewer while busy.
function SiteDashboardResults(props: SiteDashboardPanelProps) {
  const {
    evaluationTarget,
    evaluationRequests,
    previewEvidence,
    resultSummaries,
    scoreResults
  } = props;
  const { isRequestingAnalysis, analysisRequestError, onRequestAnalysis } = usePageRescanRequest(props);
  // Stable while the overview is unchanged, so the report's trend is not rebuilt
  // on every marker selection.
  const targetEvaluationRequests = useMemo(
    () => evaluationRequests.filter((request) => request.evaluationTargetId === evaluationTarget.id),
    [evaluationRequests, evaluationTarget.id]
  );
  const { latestResultRequest, latestResultRequestId, showsPreviousResult } =
    selectResultRequests(targetEvaluationRequests, previewEvidence);
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
  // Findings in advertising or changing regions stay out of the page view, the
  // counts and the report. Popup findings are left out of the score only: they
  // are listed, counted and located like any other finding, and join the
  // not-shown list when the page lacks the popup.
  const latestIssues = useMemo(() => latestResultRequestId === null ? [] : issueResults.filter((issue) =>
    (!issue.exclusionReason || issue.exclusionReason === "POPUP")
    && requestIdByAnalysisResultId.get(issue.analysisResultId) === latestResultRequestId
  ), [issueResults, latestResultRequestId, requestIdByAnalysisResultId]);
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
    setLocatorReport((current) => sameLocatorReport(current, next) ? current : next);
  }, []);
  const latestIssueSignature = latestIssues.map((issue) => issue.id).join(",");
  const { currentLocatorReport, locatorCheckState, issueStates } =
    readLocatorReport(locatorReport, latestResultRequestId, latestIssueSignature);

  function revealHiddenIssue(issueId: number) {
    setSelectedIssueId(issueId);
    setSelectedIssueFocusRequestId((current) => current + 1);
  }

  // The URL owns the selected view so reload, links and Back keep it. The
  // read-only preview must not rewrite the landing or preview page address.
  const [searchParams, setSearchParams] = useSearchParams();
  const [previewView, setPreviewView] = useState<DashboardView>("results");
  const view = previewEvidence ? previewView : parseDashboardView(searchParams.get("view"));
  const [hasOpenedReport, setHasOpenedReport] = useState(view === "report");
  const pendingPageFocusRef = useRef(false);
  const evidenceGridItemRef = useRef<HTMLDivElement>(null);

  function changeView(next: DashboardView) {
    if (next === view) return;
    if (previewEvidence) {
      setPreviewView(next);
      return;
    }
    // The page detail route has no other query parameters to preserve.
    setSearchParams(next === "report" ? { view: "report" } : {});
  }

  function showIssueOnPage(issueId: number) {
    pendingPageFocusRef.current = true;
    changeView("results");
    revealHiddenIssue(issueId);
  }

  // The report mounts on first use and then keeps its filters. When a report
  // button moves to the page, that button is hidden with its panel: bring the
  // page view into sight and keep keyboard focus on it instead of the body.
  // Router updates commit as a transition, so act once the view has changed.
  useEffect(() => {
    if (view === "report") {
      setHasOpenedReport(true);
      return;
    }
    if (!pendingPageFocusRef.current) return;
    pendingPageFocusRef.current = false;
    const gridItem = evidenceGridItemRef.current;
    gridItem?.scrollIntoView({ block: "start" });
    gridItem?.querySelector<HTMLElement>(".site-report-focus-guard")?.focus({ preventScroll: true });
  }, [view]);

  useEffect(() => {
    // The id signature, not the array, drives this: pending detail hooks can
    // return a new but equivalent array on every render.
    const latestIssueIds = latestIssueSignature ? latestIssueSignature.split(",").map(Number) : [];
    setSelectedIssueId((current) => {
      if (current !== null && latestIssueIds.includes(current)) {
        return current;
      }

      // Markers should start in their neutral state. A target is highlighted
      // only after the user hovers, focuses, or explicitly selects its marker.
      return null;
    });
  }, [latestIssueSignature, latestResultRequestId]);

  const replayIssueRows = useMemo(() => latestIssues.map((issue): RecentIssueRow => ({
    issue,
    severity: severityChartItems.find((item) => item.key === issue.severity) ?? severityChartItems[0]!,
    analyzerType: analysisResultById.get(issue.analysisResultId)?.analyzerType
  })), [analysisResultById, latestIssues]);
  const unavailableLocatorIssueRows = useMemo(() => {
    const unavailableIssueIds = new Set(currentLocatorReport?.unavailableIssueIds);
    return replayIssueRows.filter(({ issue }) => unavailableIssueIds.has(issue.id));
  }, [replayIssueRows, currentLocatorReport]);
  const recoverableHiddenLocatorIssueRows = useMemo(() => {
    const hiddenIssueIds = new Set(currentLocatorReport?.recoverableHiddenIssueIds);
    return replayIssueRows.filter(({ issue }) => hiddenIssueIds.has(issue.id));
  }, [currentLocatorReport, replayIssueRows]);
  const pageSettingIssueRows = useMemo(() => {
    const pageSettingIds = new Set(currentLocatorReport?.pageSettingIssueIds);
    return replayIssueRows.filter(({ issue }) => pageSettingIds.has(issue.id));
  }, [currentLocatorReport, replayIssueRows]);
  const locationRow = replayIssueRows.find(({ issue }) => issue.id === locationIssueId);
  const evidenceLiveSessionLoadState = evidenceLiveSessionLoadStateOf(
    previewEvidence !== undefined,
    resultDetailsLoadState,
    liveSessionLoadState,
    latestResultRequestId
  );
  const retryEvidence = () => {
    if (resultDetailsLoadState === "error") {
      retryResultDetails();
      return;
    }
    retryLiveSession();
    retryCaptureMetadata();
  };
  const { deviceScaleFactor: captureDeviceScaleFactor, analyzedAt: latestAnalyzedAt } =
    readCapture(captureMetadata, latestResultRequest);
  // Severity comes from the result-details request and remains independent of
  // whether the current live page can still resolve every historical locator.
  const showsRailDetailCards = resultDetailsLoadState === "ready";

  return (
    <div className="site-dashboard-view" data-active-view={view}>
      <DashboardViewTabs value={view} onChange={changeView} />
      <div
        id="site-dashboard-panel-results"
        role="tabpanel"
        aria-labelledby="site-dashboard-tab-results"
        className="site-dashboard-layout grid min-h-[31rem] grid-cols-1 items-stretch"
      >
        <div ref={evidenceGridItemRef} className="site-page-evidence-grid-item">
          <RenderedPageEvidenceCard
            accessUrl={evaluationTarget.accessUrl}
            headerActions={<PageAnalysisActions
              analyzedAt={latestAnalyzedAt}
              isRequestingAnalysis={isRequestingAnalysis}
              analysisRequestError={analysisRequestError}
              onRequestAnalysis={onRequestAnalysis}
            />}
            faviconUrl={evaluationTarget.faviconUrl}
            captureMetadata={captureMetadata}
            captureMetadataLoadState={captureMetadataLoadState}
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
          <ResultNotices
            showsPreviousResult={showsPreviousResult}
            analyzedAt={latestAnalyzedAt}
            analysisRequestError={analysisRequestError}
            captureMetadataLoadState={captureMetadataLoadState}
            captureMetadataErrorMessage={captureMetadataErrorMessage}
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
              <SeverityDistributionPanel issues={latestIssues}>
                {liveSessionLoadState === "error" && <p className="site-result-notice" role="status">
                  현재 페이지에 연결하지 못했습니다. 저장된 분석 결과를 표시합니다.
                </p>}
              </SeverityDistributionPanel>
              <ErrorBoundary resetKey={String(latestResultRequestId)} fallback={() => null}>
                <Suspense fallback={null}>
                  <UnavailableLocatorPanel
                    mode="page-settings"
                    checkState={locatorCheckState}
                    rows={pageSettingIssueRows}
                    onShowLocation={setLocationIssueId}
                    issueStates={issueStates}
                  />
                  {/* Findings in another screen state join the hidden list as
                      one of its filters. */}
                  <UnavailableLocatorPanel
                    checkState={locatorCheckState}
                    hasHiddenIssues={pageSettingIssueRows.length > 0}
                    rows={unavailableLocatorIssueRows}
                    recoverableRows={recoverableHiddenLocatorIssueRows}
                    onSelectIssue={revealHiddenIssue}
                    onShowLocation={setLocationIssueId}
                    issueStates={issueStates}
                  />
                </Suspense>
              </ErrorBoundary>
            </>
          )}
        </div>
      </div>
      <div
        id="site-dashboard-panel-report"
        role="tabpanel"
        aria-labelledby="site-dashboard-tab-report"
        className="site-dashboard-report-panel"
        hidden={view !== "report"}
      >
        {hasOpenedReport && (
          <ErrorBoundary resetKey={String(latestResultRequestId)} fallback={RoutePanelErrorFallback}>
            <Suspense fallback={<RoutePanelFallback />}>
              <FinalReportPanel
                active={view === "report"}
                target={evaluationTarget}
                analyzedAt={latestAnalyzedAt}
                requestId={latestResultRequestId}
                evaluationRequests={targetEvaluationRequests}
                scoreResults={scoreResults}
                resultSummaries={resultSummaries}
                rows={replayIssueRows}
                loadState={resultDetailsLoadState}
                errorMessage={resultDetailsErrorMessage}
                onRetry={retryResultDetails}
                locatorCheckState={locatorCheckState}
                issueStates={issueStates}
                onShowOnPage={showIssueOnPage}
                deviceScaleFactor={captureDeviceScaleFactor}
                onRequestAnalysis={onRequestAnalysis}
                isRequestingAnalysis={isRequestingAnalysis}
                analysisRequestError={analysisRequestError}
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
      {locationRow ? (
        <ErrorBoundary
          resetKey={`issue-location:${locationRow.issue.id}`}
          fallback={({ error, resetErrorBoundary }) => (
            <ModalErrorFallback
              isChunkError={isLazyChunkLoadError(error)}
              onDismiss={() => setLocationIssueId(null)}
              onRetry={resetErrorBoundary}
              onReload={() => window.location.reload()}
            />
          )}
        >
          <Suspense fallback={<ModalLoadFallback />}>
            <IssueLocationDialog
              row={locationRow}
              onClose={() => setLocationIssueId(null)}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </div>
  );
}
