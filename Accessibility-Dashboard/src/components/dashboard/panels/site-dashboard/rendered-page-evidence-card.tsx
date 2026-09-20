import { MonitorOff, RefreshCw } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { EvaluationCaptureMetadata, LiveReportSession } from "@/types/accessibility-domain";

import { formatIssueCodeLabel } from "./constants";
import { PageFavicon } from "./page-favicon";
import { getReplaySourceWidth, type EvidenceFrameKind } from "./evidence-source";
import { getPageEvidenceLoadingProgress, type PageEvidenceLoadingPhase } from "./page-evidence-loading-progress";
import {
  REPLAY_VIEW_SCALE_MIN, REPLAY_VIEW_SCALE_MAX, REPLAY_VISUAL_WIDTH_MAX,
  type ReplayViewportMetrics
} from "./page-replay-protocol";
import type { LocatorReport, RecentIssueRow } from "./types";
import type { LiveReportSessionLoadState } from "./use-live-report-session";
import { usePageEvidenceConnection } from "./use-page-evidence-connection";

type RenderedPageEvidenceCardProps = {
  accessUrl: string;
  headerActions: ReactNode;
  faviconUrl?: string | null;
  captureMetadata: EvaluationCaptureMetadata | null;
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

export function RenderedPageEvidenceCard({
  accessUrl,
  headerActions,
  faviconUrl,
  captureMetadata,
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
  const {
    iframeRef, frameIdentity, frameRevision, frameRuntimeUrl,
    activeFrameKind, effectiveLoadState, replayConnectionState, replayLoadingPhase,
    documentTitle, isDocumentScrolled, fallbackIssue,
    unavailableLocatorCount, recoverableHiddenLocatorCount,
    handleFrameLoad, handleFrameError, retryFrame, enterReportFocus
  } = usePageEvidenceConnection({
    evaluationRequestId, liveSession, liveSessionLoadState, onRetryLiveSession,
    onLocatorReportChange, onSelectIssue, previewRuntimeUrl, rows, selectedIssueId,
    selectedIssueFocusRequestId, replayViewportMetrics, chromeHeight
  });
  const headerTitle = documentTitle === null ? "" : documentTitle || "제목 없음";
  const loadingFrameKind = activeFrameKind ?? "live";
  const replayLoadingMessage = getPageEvidenceLoadingMessage({
    frameKind: loadingFrameKind,
    phase: replayLoadingPhase
  });
  const showsReplayLoadingOverlay = replayConnectionState === "loading"
    || (replayConnectionState === "ready" && replayLoadingPhase !== "complete");
  const isPageLoading = effectiveLoadState === "loading"
    || (effectiveLoadState === "ready" && showsReplayLoadingOverlay);
  const replaySourceWidth = getReplaySourceWidth(captureMetadata, activeFrameKind);
  const replayScale = replayViewportMetrics.scale;
  const replayFrameStyle = activeFrameKind !== null && captureMetadata && replayScale < 0.999
    ? {
        width: `${replaySourceWidth}px`,
        height: `${100 / replayScale}%`,
        transform: `scale(${replayScale})`,
        transformOrigin: "top left"
      }
    : undefined;

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
      data-document-scrolled={isDocumentScrolled && replayConnectionState === "ready"}>
      <header ref={chromeRef} className="site-page-evidence-chrome"
        data-scrolled={isDocumentScrolled && replayConnectionState === "ready"}>
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
        {effectiveLoadState === "loading" && (
          <div className="site-page-evidence-loading" role="status" aria-live="polite">
            <PageEvidenceLoadingBar
              frameKind={loadingFrameKind}
              label={replayLoadingMessage}
              phase={replayLoadingPhase}
            />
            <span>{replayLoadingMessage}</span>
          </div>
        )}

        {effectiveLoadState === "idle" && (
          <EmptyEvidenceState />
        )}

        {effectiveLoadState === "error" && (
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
        )}

        {effectiveLoadState === "ready" && activeFrameKind !== null && frameRuntimeUrl !== null && (
          <div className="site-page-evidence-grid">
            <div className="site-page-evidence-replay-column">
              <div
                ref={previewRef}
                className="site-page-evidence-preview"
                role="region"
                aria-label={`${targetName} 접근성 검사 ${activeFrameKind === "live" ? "동적" : "제품 미리보기"} 화면`}
                aria-busy={showsReplayLoadingOverlay}
                data-connection-state={replayConnectionState}
                data-loading-phase={replayLoadingPhase}
                data-unavailable-locator-count={unavailableLocatorCount}
                data-hidden-state-locator-count={recoverableHiddenLocatorCount}
                data-focus-request-id={selectedIssueFocusRequestId}
              >
                {activeFrameKind === "live" && (
                  <button type="button" className="site-report-focus-guard"
                    data-live-report-focus-guard="forward"
                    tabIndex={replayConnectionState === "ready" ? 0 : -1}
                    onFocus={event => enterReportFocus("forward", event.currentTarget)}
                    onClick={() => enterReportFocus("forward")}>이슈 마커로 이동</button>
                )}
                <iframe
                  key={`${frameIdentity ?? "none"}:${frameRevision}`}
                  ref={iframeRef}
                  className="site-page-evidence-replay-frame"
                  data-replay-scale={replayScale.toFixed(4)}
                  data-replay-visual-width={replayViewportMetrics.visualWidth.toFixed(2)}
                  data-report-mode={activeFrameKind}
                  tabIndex={activeFrameKind === "live" ? -1 : undefined}
                  src={frameRuntimeUrl}
                  style={replayFrameStyle}
                  title={`${targetName} 접근성 검사 페이지 ${activeFrameKind === "live" ? "동적 보기" : "제품 미리보기"}`}
                  sandbox={activeFrameKind === "live"
                    ? "allow-scripts allow-same-origin allow-forms"
                    : "allow-scripts"}
                  referrerPolicy="no-referrer"
                  loading={activeFrameKind === "live" ? "eager" : "lazy"}
                  onLoad={handleFrameLoad}
                  onError={handleFrameError}
                />

                {activeFrameKind === "live" && (
                  <button type="button" className="site-report-focus-guard"
                    data-live-report-focus-guard="backward"
                    tabIndex={replayConnectionState === "ready" ? 0 : -1}
                    onFocus={event => enterReportFocus("backward", event.currentTarget)}
                    onClick={() => enterReportFocus("backward")}>이슈 마커로 이동</button>
                )}

                {showsReplayLoadingOverlay && (
                  <div className="site-page-evidence-replay-overlay" role="status" aria-live="polite">
                    <PageEvidenceLoadingBar
                      frameKind={loadingFrameKind}
                      label={replayLoadingMessage}
                      phase={replayLoadingPhase}
                    />
                    <span>{replayLoadingMessage}</span>
                  </div>
                )}

                {replayConnectionState === "error" && (
                  <div className="site-page-evidence-replay-overlay" role="alert">
                    <MonitorOff aria-hidden="true" size={24} />
                    <span>{activeFrameKind === "live" ? "동적 페이지와 연결하지 못했어요" : "제품 미리보기를 불러오지 못했어요"}</span>
                    <button
                      type="button"
                      onClick={retryFrame}
                    >
                      화면 다시 불러오기
                    </button>
                  </div>
                )}
              </div>

              {replayConnectionState === "ready" && fallbackIssue && (
                <div
                  className="site-page-evidence-fallback-detail"
                  data-issue-id={fallbackIssue.id}
                  aria-hidden="true"
                >
                  <div className="site-page-evidence-fallback-detail__tags">
                    <span
                      className="site-page-evidence-fallback-detail__tag site-page-evidence-fallback-detail__severity"
                      data-severity={fallbackIssue.severity}
                    >
                      {fallbackIssue.severityLabel}
                    </span>
                    <span className="site-page-evidence-fallback-detail__tag">
                      {formatIssueCodeLabel(fallbackIssue.code) || "KWCAG"}
                    </span>
                  </div>
                  <p data-copyable className="site-page-evidence-fallback-detail__title">{fallbackIssue.title}</p>
                  {fallbackIssue.message && (
                    <p data-copyable className="site-page-evidence-fallback-detail__message">{fallbackIssue.message}</p>
                  )}
                  {fallbackIssue.path && (
                    <code className="site-page-evidence-fallback-detail__path">{fallbackIssue.path}</code>
                  )}
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    </article>
  );
}
