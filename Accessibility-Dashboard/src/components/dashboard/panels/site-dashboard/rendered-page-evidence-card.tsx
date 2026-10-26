import { Maximize2, MonitorOff, RefreshCw, X } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { EvaluationCaptureMetadata, LiveReportSession } from "@/types/accessibility-domain";

import { useIsMobileDashboard } from "../../dashboard-surface-hooks";
import { useDialogAccessibility } from "../../shared/use-dialog-accessibility";
import { formatIssueCodeLabel } from "./constants";
import { PageFavicon } from "./page-favicon";
import { getReplaySourceWidth, resolveReplayCaptureMetadataStatus, type EvidenceFrameKind } from "./evidence-source";
import { getPageEvidenceLoadingProgress, type PageEvidenceLoadingPhase } from "./page-evidence-loading-progress";
import {
  REPLAY_VIEW_SCALE_MIN, REPLAY_VIEW_SCALE_MAX, REPLAY_VISUAL_WIDTH_MAX,
  type ReplayViewportMetrics
} from "./page-replay-protocol";
import type { LocatorReport, RecentIssueRow } from "./types";
import type { EvaluationCaptureMetadataLoadState } from "./use-evaluation-capture-metadata";
import type { LiveReportSessionLoadState } from "./use-live-report-session";
import { usePageEvidenceConnection } from "./use-page-evidence-connection";

type RenderedPageEvidenceCardProps = {
  accessUrl: string;
  headerActions: ReactNode;
  faviconUrl?: string | null;
  captureMetadata: EvaluationCaptureMetadata | null;
  captureMetadataLoadState?: EvaluationCaptureMetadataLoadState;
  errorMessage: string | null;
  evaluationRequestId: number | null;
  liveSession: LiveReportSession | null;
  liveSessionLoadState: LiveReportSessionLoadState;
  onRetry: () => void;
  onRetryLiveSession: () => void;
  onLocatorReportChange: (report: LocatorReport) => void;
  onSelectIssue: (issueId: number | null) => void;
  previewRuntimeUrl?: string;
  rows: RecentIssueRow[];
  selectedIssueId: number | null;
  selectedIssueFocusRequestId: number;
  targetName: string;
};

// 페이지는 다른 출처라 별도 프로세스에서 그려진다. iframe을 transform: scale로 줄이면 그 안의
// 합성 레이어(고정 헤더, 슬라이드, 그 위에 겹친 문제 설명창 등)가 줄이기 전 해상도로 그려진 뒤
// 축소되어 흐려진다. Chromium은 iframe의 zoom을 안쪽 문서의 배율로 넘겨 처음부터 줄인 크기로
// 그리므로 그 방식을 쓴다. 안쪽 화면 크기는 같다(가로 = 원본 너비, 세로 = 칸 높이 / 배율).
// 자동화 브라우저(navigator.webdriver)는 zoom된 iframe 안 요소 좌표를 잘못 계산해 클릭·호버가
// 엇나가므로 기존 방식을 유지하고, iframe zoom 전달이 확인되지 않은 다른 엔진도 기존 방식을 쓴다.
const frameZoomSupported = typeof navigator !== "undefined" && !navigator.webdriver
  && ((navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
    .userAgentData?.brands?.some(({ brand }) => brand === "Chromium") ?? false);

const PHONE_POPOVER_SCALE = 0.85;

type PageEvidenceLoadingBarStyle = CSSProperties & {
  "--site-page-evidence-loading-progress": number;
};

function PageEvidenceLoadingBar({
  frameKind,
  label,
  phase
}: {
  frameKind: Exclude<EvidenceFrameKind, null>;
  label: string;
  phase: PageEvidenceLoadingPhase;
}) {
  const progress = getPageEvidenceLoadingProgress(phase, frameKind);
  const style: PageEvidenceLoadingBarStyle = {
    "--site-page-evidence-loading-progress": progress.value
  };

  return (
    <span
      aria-label="페이지 검사 화면 준비 진행률"
      aria-valuemax={progress.totalSteps}
      aria-valuemin={0}
      aria-valuenow={progress.completedSteps}
      aria-valuetext={`${label} (${progress.completedSteps}/${progress.totalSteps}단계)`}
      className="site-page-evidence-loading-bar"
      data-loading-phase={phase}
      data-loading-progress={`${progress.completedSteps}/${progress.totalSteps}`}
      role="progressbar"
      style={style}
    />
  );
}

function getPageEvidenceLoadingMessage({
  frameKind,
  phase
}: {
  frameKind: Exclude<EvidenceFrameKind, null>;
  phase: PageEvidenceLoadingPhase;
}): string {
  switch (phase) {
    case "request-started":
      return frameKind === "live"
        ? "동적 검사 화면을 준비하는 중입니다"
        : "제품 미리보기를 준비하는 중입니다";
    case "source-ready":
      return "페이지 문서를 불러오는 중입니다";
    case "frame-loaded":
      return frameKind === "live"
        ? "동적 페이지에 연결하는 중입니다"
        : "제품 미리보기를 초기화하는 중입니다";
    case "bridge-connected":
      return "페이지 연결을 확인하는 중입니다";
    case "document-ready":
      return "페이지 내용을 확인하는 중입니다";
    case "complete":
      return "페이지 검사 화면 준비를 마쳤습니다";
  }
}

function EmptyEvidenceState() {
  return (
    <div className="site-page-evidence-empty" role="status">
      <MonitorOff aria-hidden="true" size={26} strokeWidth={1.8} />
      <div>
        <p className="site-page-evidence-empty-title">
          아직 표시할 동적 페이지가 없어요
        </p>
        <p className="site-page-evidence-empty-description">
          검사가 완료되면 현재 페이지와 문제 요소를 여기에서 직접 확인할 수 있어요.
        </p>
      </div>
    </div>
  );
}

type PageEvidenceConnection = ReturnType<typeof usePageEvidenceConnection>;

function LoadingStatus({ className, frameKind, phase }: {
  className: string;
  frameKind: EvidenceFrameKind;
  phase: PageEvidenceLoadingPhase;
}) {
  const loadingFrameKind = frameKind ?? "live";
  const message = getPageEvidenceLoadingMessage({ frameKind: loadingFrameKind, phase });
  return (
    <div className={className} role="status" aria-live="polite">
      <PageEvidenceLoadingBar
        frameKind={loadingFrameKind}
        label={message}
        phase={phase}
      />
      <span>{message}</span>
    </div>
  );
}

function PageEvidenceStatus({ connection, errorMessage, onRetry }: {
  connection: PageEvidenceConnection;
  errorMessage: string | null;
  onRetry: () => void;
}) {
  const loadState = connection.effectiveLoadState;
  if (loadState === "loading") {
    return <LoadingStatus className="site-page-evidence-loading" frameKind={connection.activeFrameKind} phase={connection.replayLoadingPhase} />;
  }
  if (loadState === "idle") return <EmptyEvidenceState />;
  if (loadState !== "error") return null;
  return (
    <div className="site-page-evidence-empty" role="alert">
      <MonitorOff aria-hidden="true" size={26} strokeWidth={1.8} />
      <div>
        <p className="site-page-evidence-empty-title">현재 동적 페이지를 열지 못했어요</p>
        <p className="site-page-evidence-empty-description">
          {errorMessage ??
            "원본 사이트에 연결할 수 없습니다. 잠시 후 동적 화면을 다시 시도해 주세요."}
        </p>
        <button type="button" className="site-page-evidence-retry" onClick={onRetry}>
          <RefreshCw aria-hidden="true" size={15} />
          다시 시도
        </button>
      </div>
    </div>
  );
}

function getCaptureInputs(
  captureMetadata: EvaluationCaptureMetadata | null,
  captureMetadataLoadState: EvaluationCaptureMetadataLoadState = "ready"
) {
  return {
    deviceScaleFactor: captureMetadata?.deviceScaleFactor ?? null,
    captureMetadataStatus: resolveReplayCaptureMetadataStatus(captureMetadataLoadState, captureMetadata !== null)
  };
}

// The page's address once its frame can be shown.
function getReplayFrameUrl({ effectiveLoadState, activeFrameKind, frameRuntimeUrl }: PageEvidenceConnection): string | null {
  return effectiveLoadState === "ready" && activeFrameKind !== null ? frameRuntimeUrl : null;
}

function getHeaderTitle(documentTitle: string | null): string {
  return documentTitle === null ? "" : documentTitle || "제목 없음";
}

function getEvidenceCardState({
  effectiveLoadState, replayConnectionState, replayLoadingPhase, isDocumentScrolled
}: PageEvidenceConnection) {
  const showsReplayLoadingOverlay = replayConnectionState === "loading"
    || (replayConnectionState === "ready" && replayLoadingPhase !== "complete");
  return {
    showsReplayLoadingOverlay,
    isPageLoading: effectiveLoadState === "loading"
      || (effectiveLoadState === "ready" && showsReplayLoadingOverlay),
    connectionError: effectiveLoadState === "error" || (effectiveLoadState === "ready" && replayConnectionState === "error"),
    documentScrolled: isDocumentScrolled && replayConnectionState === "ready"
  };
}

function getPhoneViewState(
  isMobileDashboard: boolean,
  isExpanded: boolean,
  hasReplayFrame: boolean,
  replayConnectionState: PageEvidenceConnection["replayConnectionState"]
) {
  const viewerOpen = isExpanded && hasReplayFrame;
  const isCompactPreview = isMobileDashboard && !viewerOpen;
  return {
    viewerOpen,
    showsExpandButton: isMobileDashboard && hasReplayFrame && replayConnectionState === "ready",
    isCompactPreview,
    focusGuardTabIndex: replayConnectionState === "ready" && !isCompactPreview ? 0 : -1
  };
}

// Set the desktop width on the very first frame load, before page scripts
// can choose a mobile layout. Scale only its presentation in the dashboard.
// A preview wider than that width is filled at full size instead.
function getReplayFrameStyle(
  activeFrameKind: EvidenceFrameKind,
  replaySourceWidth: number,
  replayScale: number
): CSSProperties | undefined {
  const replayFrameWidth = `max(${replaySourceWidth}px, 100%)`;
  return activeFrameKind !== null && replaySourceWidth > 0
    ? frameZoomSupported
      ? {
          width: replayFrameWidth,
          height: "100%",
          zoom: String(replayScale)
        }
      : {
          width: replayFrameWidth,
          height: `${100 / replayScale}%`,
          transform: `scale(${replayScale})`,
          transformOrigin: "top left"
        }
    : undefined;
}

const viewerDialogAttributes = {
  "data-expanded": true,
  role: "dialog",
  "aria-modal": true,
  "aria-labelledby": "site-page-evidence-viewer-title"
};

function ReportFocusGuard({ direction, frameKind, tabIndex, onEnter }: {
  direction: "forward" | "backward";
  frameKind: EvidenceFrameKind;
  tabIndex: number;
  onEnter: PageEvidenceConnection["enterReportFocus"];
}) {
  if (frameKind !== "live") return null;
  return (
    <button type="button" className="site-report-focus-guard"
      data-live-report-focus-guard={direction}
      tabIndex={tabIndex}
      onFocus={event => onEnter(direction, event.currentTarget)}
      onClick={() => onEnter(direction)}>이슈 마커로 이동</button>
  );
}

function ReplayStatusOverlay({ connection, frameKind, showsLoading }: {
  connection: PageEvidenceConnection;
  frameKind: EvidenceFrameKind;
  showsLoading: boolean;
}) {
  if (showsLoading) {
    return <LoadingStatus className="site-page-evidence-replay-overlay" frameKind={frameKind} phase={connection.replayLoadingPhase} />;
  }
  if (connection.replayConnectionState !== "error") return null;
  return (
    <div className="site-page-evidence-replay-overlay" role="alert">
      <MonitorOff aria-hidden="true" size={24} />
      <span>{frameKind === "live" ? "동적 페이지와 연결하지 못했어요" : "제품 미리보기를 불러오지 못했어요"}</span>
      <button
        type="button"
        onClick={connection.retryFrame}
      >
        화면 다시 불러오기
      </button>
    </div>
  );
}

function ReplayFrame({ connection, frameKind, src, style, viewportMetrics, targetName }: {
  connection: PageEvidenceConnection;
  frameKind: EvidenceFrameKind;
  src: string;
  style: CSSProperties | undefined;
  viewportMetrics: ReplayViewportMetrics;
  targetName: string;
}) {
  return (
    <iframe
      key={`${connection.frameIdentity ?? "none"}:${connection.frameRevision}`}
      ref={connection.iframeRef}
      className="site-page-evidence-replay-frame"
      data-replay-scale={viewportMetrics.scale.toFixed(4)}
      data-replay-visual-width={viewportMetrics.visualWidth.toFixed(2)}
      data-report-mode={frameKind}
      tabIndex={frameKind === "live" ? -1 : undefined}
      src={src}
      style={style}
      title={`${targetName} 접근성 검사 페이지 ${frameKind === "live" ? "동적 보기" : "제품 미리보기"}`}
      sandbox={frameKind === "live"
        ? "allow-scripts allow-same-origin allow-forms"
        : "allow-scripts"}
      referrerPolicy="no-referrer"
      loading={frameKind === "live" ? "eager" : "lazy"}
      onLoad={connection.handleFrameLoad}
      onError={connection.handleFrameError}
    />
  );
}

function FallbackIssueDetail({ connection }: { connection: PageEvidenceConnection }) {
  const issue = connection.fallbackIssue;
  if (connection.replayConnectionState !== "ready" || !issue) return null;
  return (
    <div
      className="site-page-evidence-fallback-detail"
      data-issue-id={issue.id}
      aria-hidden="true"
    >
      <div className="site-page-evidence-fallback-detail__tags">
        <span
          className="site-page-evidence-fallback-detail__tag site-page-evidence-fallback-detail__severity"
          data-severity={issue.severity}
        >
          {issue.severityLabel}
        </span>
        <span className="site-page-evidence-fallback-detail__tag">
          {formatIssueCodeLabel(issue.code) || "KWCAG"}
        </span>
      </div>
      <p data-copyable className="site-page-evidence-fallback-detail__title">{issue.title}</p>
      {issue.message && (
        <p data-copyable className="site-page-evidence-fallback-detail__message">{issue.message}</p>
      )}
      {issue.path && (
        <code className="site-page-evidence-fallback-detail__path">{issue.path}</code>
      )}
    </div>
  );
}

export function RenderedPageEvidenceCard({
  accessUrl,
  headerActions,
  faviconUrl,
  captureMetadata,
  captureMetadataLoadState,
  errorMessage,
  evaluationRequestId,
  liveSession,
  liveSessionLoadState,
  onRetry,
  onRetryLiveSession,
  onLocatorReportChange,
  onSelectIssue,
  previewRuntimeUrl,
  rows,
  selectedIssueId,
  selectedIssueFocusRequestId,
  targetName
}: RenderedPageEvidenceCardProps) {
  const [chromeHeight, setChromeHeight] = useState(0);
  const chromeRef = useRef<HTMLElement>(null);
  const [replayViewportMetrics, setReplayViewportMetrics] = useState<ReplayViewportMetrics>({
    scale: 1,
    visualWidth: 0
  });
  const previewRef = useRef<HTMLDivElement>(null);
  // Phones show the desktop page small, with dots for markers; "크게 보기"
  // opens it over the whole screen, where the phone's own pinch zoom works.
  const isMobileDashboard = useIsMobileDashboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const closeViewerButtonRef = useRef<HTMLButtonElement>(null);
  const sentViewportMetrics = useMemo<ReplayViewportMetrics>(() => ({
    ...replayViewportMetrics,
    markerDensity: isMobileDashboard && !isExpanded ? "compact" : "regular",
    // A desktop-sized issue popover covers most of a phone screen. The larger
    // view stays open on a phone turned sideways, past the phone breakpoint.
    popoverScale: isMobileDashboard || isExpanded ? PHONE_POPOVER_SCALE : 1
  }), [isExpanded, isMobileDashboard, replayViewportMetrics]);
  const connection = usePageEvidenceConnection({
    evaluationRequestId, liveSession, liveSessionLoadState, onRetryLiveSession,
    onLocatorReportChange, onSelectIssue, previewRuntimeUrl, rows,
    selectedIssueId, selectedIssueFocusRequestId, replayViewportMetrics: sentViewportMetrics,
    // The larger view has no page header over the page's top edge.
    chromeHeight: isExpanded ? 0 : chromeHeight,
    ...getCaptureInputs(captureMetadata, captureMetadataLoadState)
  });
  const {
    iframeRef, frameIdentity, frameRevision, activeFrameKind, effectiveLoadState,
    replayConnectionState, replayLoadingPhase, enterReportFocus, resetAutomaticLiveRecovery
  } = connection;
  const headerTitle = getHeaderTitle(connection.documentTitle);
  const { showsReplayLoadingOverlay, isPageLoading, connectionError, documentScrolled } = getEvidenceCardState(connection);
  const replaySourceWidth = getReplaySourceWidth(captureMetadata, activeFrameKind);
  const replayFrameUrl = getReplayFrameUrl(connection);
  const hasReplayFrame = replayFrameUrl !== null;
  const { viewerOpen, showsExpandButton, isCompactPreview, focusGuardTabIndex } = getPhoneViewState(
    isMobileDashboard, isExpanded, hasReplayFrame, replayConnectionState
  );

  const closeViewer = useCallback(() => setIsExpanded(false), []);
  const viewerRef = useDialogAccessibility<HTMLDivElement>({
    isOpen: viewerOpen,
    onClose: closeViewer,
    initialFocusRef: closeViewerButtonRef,
    returnFocusRef: expandButtonRef
  });
  // The frame can go away (a new analysis, an error) while the view is open.
  useLayoutEffect(() => {
    if (isExpanded && !hasReplayFrame) closeViewer();
  }, [closeViewer, hasReplayFrame, isExpanded]);

  // The small phone preview only shows where the findings are; reading and
  // choosing them happens in the larger view, so the page itself is inert.
  useLayoutEffect(() => {
    const frame = iframeRef.current;
    if (frame) frame.inert = isCompactPreview;
  }, [iframeRef, isCompactPreview, frameIdentity, frameRevision, hasReplayFrame]);

  const replayFrameStyle = getReplayFrameStyle(activeFrameKind, replaySourceWidth, replayViewportMetrics.scale);

  useLayoutEffect(() => {
    const chrome = chromeRef.current;
    if (!chrome) return;
    const measure = () => setChromeHeight(chrome.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chrome);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const sourceWidth = replaySourceWidth;
    if (effectiveLoadState !== "ready" || !preview) {
      setReplayViewportMetrics({
        scale: 1,
        visualWidth: preview?.clientWidth ?? 0
      });
      return;
    }

    const updateReplayScale = () => {
      const availableWidth = preview.clientWidth;
      if (availableWidth <= 0) {
        return;
      }
      const nextScale = sourceWidth > 0
        ? Math.max(
            REPLAY_VIEW_SCALE_MIN,
            Math.min(REPLAY_VIEW_SCALE_MAX, availableWidth / sourceWidth)
          )
        : 1;
      const nextVisualWidth = Math.min(REPLAY_VISUAL_WIDTH_MAX, availableWidth);
      setReplayViewportMetrics((currentMetrics) => {
        if (
          Math.abs(currentMetrics.scale - nextScale) < 0.001
          && Math.abs(currentMetrics.visualWidth - nextVisualWidth) < 0.5
        ) {
          return currentMetrics;
        }
        return {
          scale: nextScale,
          visualWidth: nextVisualWidth
        };
      });
    };

    updateReplayScale();
    const resizeObserver = new ResizeObserver(updateReplayScale);
    resizeObserver.observe(preview);
    return () => resizeObserver.disconnect();
  }, [effectiveLoadState, frameIdentity, replaySourceWidth]);

  return (
    <article aria-label="페이지 검사 화면" className="dashboard-card site-page-evidence-card"
      data-loading={isPageLoading}
      data-connection-error={connectionError}
      data-document-scrolled={documentScrolled}>
      <header ref={chromeRef} className="site-page-evidence-chrome"
        data-scrolled={documentScrolled}>
        <div className="site-page-evidence-chrome__identity" style={{ visibility: isPageLoading ? "hidden" : undefined }}>
          <PageFavicon key={faviconUrl ?? "fallback"} faviconUrl={faviconUrl} className="site-page-evidence-chrome__icon" />
          <h2 id="site-page-evidence-heading" title={headerTitle}>{headerTitle}</h2>
        </div>
        <a className="site-page-evidence-chrome__address" href={accessUrl}
          target="_blank" rel="noreferrer" title={accessUrl} draggable={false}>
          {accessUrl}
        </a>
        {headerActions}
      </header>

      <div className="site-page-evidence-body">
        <PageEvidenceStatus
          connection={connection}
          errorMessage={errorMessage}
          onRetry={() => {
            resetAutomaticLiveRecovery();
            onRetry();
          }}
        />

        {hasReplayFrame && (
          <div className="site-page-evidence-grid">
            <div
              ref={viewerRef}
              className="site-page-evidence-replay-column"
              {...(viewerOpen ? viewerDialogAttributes : undefined)}
            >
              {viewerOpen && (
                <div className="site-page-evidence-viewer-bar">
                  <button ref={closeViewerButtonRef} type="button" className="site-page-evidence-viewer-button"
                    aria-label="크게 보기 닫기" onClick={closeViewer}>
                    <X aria-hidden="true" size={22} strokeWidth={2} />
                  </button>
                  <div className="site-page-evidence-viewer-heading">
                    <h2 id="site-page-evidence-viewer-title">{headerTitle || targetName}</h2>
                  </div>
                </div>
              )}
              <div
                ref={previewRef}
                className="site-page-evidence-preview"
                role="region"
                aria-label={`${targetName} 접근성 검사 ${activeFrameKind === "live" ? "동적" : "제품 미리보기"} 화면`}
                aria-busy={showsReplayLoadingOverlay}
                data-connection-state={replayConnectionState}
                data-loading-phase={replayLoadingPhase}
                data-unavailable-locator-count={connection.unavailableLocatorCount}
                data-hidden-state-locator-count={connection.recoverableHiddenLocatorCount}
                data-focus-request-id={selectedIssueFocusRequestId}
                data-marker-density={sentViewportMetrics.markerDensity}
              >
                <ReportFocusGuard direction="forward" frameKind={activeFrameKind}
                  tabIndex={focusGuardTabIndex} onEnter={enterReportFocus} />
                <ReplayFrame
                  connection={connection}
                  frameKind={activeFrameKind}
                  src={replayFrameUrl}
                  style={replayFrameStyle}
                  viewportMetrics={sentViewportMetrics}
                  targetName={targetName}
                />

                <ReportFocusGuard direction="backward" frameKind={activeFrameKind}
                  tabIndex={focusGuardTabIndex} onEnter={enterReportFocus} />

                {showsExpandButton && (
                  <button ref={expandButtonRef} type="button" className="site-page-evidence-expand"
                    hidden={viewerOpen} onClick={() => setIsExpanded(true)}>
                    <span className="site-page-evidence-expand__label">
                      <Maximize2 aria-hidden="true" size={18} strokeWidth={2} />
                      크게 보기
                    </span>
                  </button>
                )}

                <ReplayStatusOverlay connection={connection} frameKind={activeFrameKind}
                  showsLoading={showsReplayLoadingOverlay} />
              </div>

              <FallbackIssueDetail connection={connection} />
            </div>

          </div>
        )}
      </div>
    </article>
  );
}
