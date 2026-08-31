import { MonitorOff, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getEvaluationArtifactContentUrl } from "@/services/backend-api";
import type { EvaluationArtifact } from "@/types/accessibility-domain";

import { formatDateTime } from "../../shared/utils";
import { formatIssueCodeLabel } from "./constants";
import {
  DASHBOARD_REPLAY_SOURCE,
  REPLAY_VIEW_SCALE_MAX,
  REPLAY_VIEW_SCALE_MIN,
  REPLAY_VISUAL_WIDTH_MAX,
  isValidReplayViewportMetrics,
  parsePageReplayMessage,
  toPageReplayIssue,
  type DashboardToPageReplayMessage,
  type ReplayViewportMetrics
} from "./page-replay-protocol";
import type { RecentIssueRow } from "./types";
import type { EvaluationArtifactLoadState } from "./use-evaluation-artifact";

type ReplayConnectionState = "loading" | "ready" | "error";

type RenderedPageEvidenceCardProps = {
  artifact: EvaluationArtifact | null;
  artifactContentUrl?: string;
  errorMessage: string | null;
  loadState: EvaluationArtifactLoadState;
  onRetry: () => void;
  onSelectIssue: (issueId: number | null) => void;
  rows: RecentIssueRow[];
  selectedIssueId: number | null;
  targetName: string;
};

const REPLAY_READY_TIMEOUT_MS = 8_000;
// Keep this in sync with ReplayDocumentSanitizer's root WebKit scrollbar width.
// The gutter is part of the iframe's logical capture width while the frame is scaled.
const REPLAY_SCROLLBAR_GUTTER_PX = 10;

function EmptyEvidenceState({
  loadState,
  onRetry
}: {
  loadState: "idle" | "empty";
  onRetry: () => void;
}) {
  return (
    <div className="site-page-evidence-empty" role="status">
      <MonitorOff aria-hidden="true" size={26} strokeWidth={1.8} />
      <div>
        <p className="site-page-evidence-empty-title">
          {loadState === "idle" ? "아직 표시할 재현 페이지가 없어요" : "이 스캔에는 재현 페이지가 없어요"}
        </p>
        <p className="site-page-evidence-empty-description">
          {loadState === "idle"
            ? "검사가 완료되면 분석한 페이지와 문제 요소를 여기에서 직접 확인할 수 있어요."
            : "DOM 재현 정보가 포함된 새 스캔을 실행하면 문제 요소를 페이지에서 확인할 수 있어요."}
        </p>
        {loadState === "empty" && (
          <button type="button" className="site-page-evidence-retry" onClick={onRetry}>
            <RefreshCw aria-hidden="true" size={15} />
            다시 확인
          </button>
        )}
      </div>
    </div>
  );
}

export function RenderedPageEvidenceCard({
  artifact,
  artifactContentUrl,
  errorMessage,
  loadState,
  onRetry,
  onSelectIssue,
  rows,
  selectedIssueId,
  targetName
}: RenderedPageEvidenceCardProps) {
  const [frameRevision, setFrameRevision] = useState(0);
  const [fallbackIssueId, setFallbackIssueId] = useState<number | null>(null);
  const [replayConnectionState, setReplayConnectionState] = useState<ReplayConnectionState>("loading");
  const [replayReadyEpoch, setReplayReadyEpoch] = useState(0);
  const [unavailableLocatorIssueIds, setUnavailableLocatorIssueIds] = useState<Set<number>>(
    () => new Set()
  );
  const [replayViewportMetrics, setReplayViewportMetrics] = useState<ReplayViewportMetrics>({
    scale: 1,
    visualWidth: 0
  });
  const previewRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const activeDocumentTokenRef = useRef<string | null>(null);
  const pendingDocumentTokenRef = useRef<string | null>(null);
  const readyAwaitingFrameLoadRef = useRef<string | null>(null);
  const retiredDocumentTokensRef = useRef(new Set<string>());
  const frameLoadObservedRef = useRef(false);
  const replayReadyTimeoutRef = useRef<number | null>(null);
  const replayReadyWatchdogEpochRef = useRef(0);
  const initializedReplayRef = useRef<{
    documentToken: string;
    issuesSignature: string;
  } | null>(null);
  const sentReplayViewportRef = useRef<{
    documentToken: string;
    scale: number;
    visualWidth: number;
  } | null>(null);
  const replayOriginSelectionRef = useRef<{ issueId: number | null } | null>(null);
  const selectedIssueStateRef = useRef(selectedIssueId);
  selectedIssueStateRef.current = selectedIssueId;

  const replayIssues = useMemo(() => rows.map(toPageReplayIssue), [rows]);
  // Polling replaces row arrays even when their wire payload is unchanged. Reinitializing the
  // replay for an identity-only change destroys marker DOM, keyboard focus, and its tooltip link.
  const replayIssuesSignature = useMemo(() => JSON.stringify(replayIssues), [replayIssues]);
  const fallbackIssue = replayIssues.find((issue) => issue.id === fallbackIssueId) ?? null;
  const selectedVisibleIssueId = replayIssues.some((issue) => issue.id === selectedIssueId)
    ? selectedIssueId
    : null;
  const unavailableLocatorCount = replayIssues.reduce(
    (count, issue) => count + Number(unavailableLocatorIssueIds.has(issue.id)),
    0
  );
  const contentUrl = artifact
    ? artifactContentUrl ?? getEvaluationArtifactContentUrl(artifact.contentUrl)
    : null;
  const replaySourceWidth = artifact
    ? Math.max(artifact.viewportWidthCssPx, artifact.pageWidthCssPx) + REPLAY_SCROLLBAR_GUTTER_PX
    : 0;
  const replayScale = replayViewportMetrics.scale;
  const replayFrameStyle = artifact && replayScale < 0.999
    ? {
        width: `${replaySourceWidth}px`,
        height: `${100 / replayScale}%`,
        transform: `scale(${replayScale})`,
        transformOrigin: "top left"
      }
    : undefined;

  function clearReplayReadyTimeout() {
    replayReadyWatchdogEpochRef.current += 1;
    if (replayReadyTimeoutRef.current !== null) {
      window.clearTimeout(replayReadyTimeoutRef.current);
      replayReadyTimeoutRef.current = null;
    }
  }

  function armReplayReadyTimeout() {
    clearReplayReadyTimeout();
    const watchdogEpoch = replayReadyWatchdogEpochRef.current;
    replayReadyTimeoutRef.current = window.setTimeout(() => {
      if (replayReadyWatchdogEpochRef.current !== watchdogEpoch) {
        return;
      }
      replayReadyTimeoutRef.current = null;
      setFallbackIssueId(null);
      setReplayConnectionState((current) => (current === "ready" ? current : "error"));
    }, REPLAY_READY_TIMEOUT_MS);
  }

  function retireDocumentToken(documentToken: string | null) {
    if (!documentToken) {
      return;
    }

    const retiredTokens = retiredDocumentTokensRef.current;
    retiredTokens.add(documentToken);
    if (retiredTokens.size > 64) {
      const oldestToken = retiredTokens.values().next().value;
      if (typeof oldestToken === "string") {
        retiredTokens.delete(oldestToken);
      }
    }
  }

  function invalidateReplayDocumentSession({ resetRetiredTokens = false } = {}) {
    retireDocumentToken(activeDocumentTokenRef.current);
    retireDocumentToken(pendingDocumentTokenRef.current);
    activeDocumentTokenRef.current = null;
    pendingDocumentTokenRef.current = null;
    readyAwaitingFrameLoadRef.current = null;
    frameLoadObservedRef.current = false;
    initializedReplayRef.current = null;
    sentReplayViewportRef.current = null;
    replayOriginSelectionRef.current = null;
    if (resetRetiredTokens) {
      retiredDocumentTokensRef.current.clear();
    }
  }

  function postToReplay(message: DashboardToPageReplayMessage) {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }

  function requestReplayDocumentState() {
    postToReplay({
      source: DASHBOARD_REPLAY_SOURCE,
      type: "REQUEST_DOCUMENT_STATE"
    });
  }

  function sendReplayViewScale() {
    const documentToken = activeDocumentTokenRef.current;
    if (
      documentToken === null
      || !isValidReplayViewportMetrics(replayViewportMetrics)
    ) {
      return;
    }

    const previous = sentReplayViewportRef.current;
    if (
      previous?.documentToken === documentToken
      && Math.abs(previous.scale - replayViewportMetrics.scale) < 0.001
      && Math.abs(previous.visualWidth - replayViewportMetrics.visualWidth) < 0.5
    ) {
      return;
    }

    postToReplay({
      source: DASHBOARD_REPLAY_SOURCE,
      type: "SET_VIEW_SCALE",
      documentToken,
      scale: replayViewportMetrics.scale,
      visualWidth: replayViewportMetrics.visualWidth
    });
    sentReplayViewportRef.current = {
      documentToken,
      scale: replayViewportMetrics.scale,
      visualWidth: replayViewportMetrics.visualWidth
    };
  }

  function sendInitialIssues() {
    const documentToken = activeDocumentTokenRef.current;
    const initializedReplay = initializedReplayRef.current;
    if (
      documentToken === null ||
      !isValidReplayViewportMetrics(replayViewportMetrics) ||
      (initializedReplay?.documentToken === documentToken &&
        initializedReplay.issuesSignature === replayIssuesSignature)
    ) {
      return;
    }

    // The replay must learn the outer iframe transform before it creates marker
    // DOM so the first painted frame uses screen-sized overlays.
    sendReplayViewScale();
    postToReplay({
      source: DASHBOARD_REPLAY_SOURCE,
      type: "INIT_ISSUES",
      issues: replayIssues,
      selectedIssueId: selectedVisibleIssueId,
      markersVisible: true
    });
    initializedReplayRef.current = {
      documentToken,
      issuesSignature: replayIssuesSignature
    };
  }

  useEffect(() => {
    setFrameRevision(0);
  }, [artifact?.contentUrl, artifact?.id]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const sourceWidth = replaySourceWidth;
    if (loadState !== "ready" || !preview || !sourceWidth) {
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
      const nextScale = Math.max(
        REPLAY_VIEW_SCALE_MIN,
        Math.min(REPLAY_VIEW_SCALE_MAX, availableWidth / sourceWidth)
      );
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
  }, [artifact?.id, loadState, replaySourceWidth]);

  useLayoutEffect(() => {
    clearReplayReadyTimeout();
    invalidateReplayDocumentSession({ resetRetiredTokens: true });
    setFallbackIssueId(null);
    setUnavailableLocatorIssueIds(new Set());
    setReplayConnectionState("loading");

    if (loadState === "ready" && artifact) {
      armReplayReadyTimeout();
    }

    return () => {
      clearReplayReadyTimeout();
      invalidateReplayDocumentSession();
    };
  }, [artifact?.id, contentUrl, frameRevision, loadState]);

  useEffect(() => {
    setFallbackIssueId(null);
  }, [frameRevision]);

  useEffect(() => {
    setFallbackIssueId(null);
    setUnavailableLocatorIssueIds(new Set());
  }, [replayIssuesSignature]);

  useEffect(() => {
    if (loadState !== "ready" || replayConnectionState !== "ready") {
      setFallbackIssueId(null);
    }
  }, [loadState, replayConnectionState]);

  useEffect(() => {
    return () => clearReplayReadyTimeout();
  }, []);

  useLayoutEffect(() => {
    function handleReplayMessage(event: MessageEvent<unknown>) {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow || event.origin !== "null") {
        return;
      }

      const message = parsePageReplayMessage(event.data);
      if (!message) {
        return;
      }

      if (message.type === "DOCUMENT_LOADING") {
        if (
          retiredDocumentTokensRef.current.has(message.documentToken) ||
          pendingDocumentTokenRef.current === message.documentToken ||
          activeDocumentTokenRef.current === message.documentToken
        ) {
          return;
        }

        retireDocumentToken(activeDocumentTokenRef.current);
        retireDocumentToken(pendingDocumentTokenRef.current);
        activeDocumentTokenRef.current = null;
        pendingDocumentTokenRef.current = message.documentToken;
        readyAwaitingFrameLoadRef.current = null;
        frameLoadObservedRef.current = false;
        initializedReplayRef.current = null;
        replayOriginSelectionRef.current = null;
        setFallbackIssueId(null);
        setUnavailableLocatorIssueIds(new Set());
        setReplayConnectionState("loading");
        armReplayReadyTimeout();
        return;
      }

      if (message.type === "DOCUMENT_UNLOADING") {
        if (
          message.documentToken !== activeDocumentTokenRef.current &&
          message.documentToken !== pendingDocumentTokenRef.current
        ) {
          return;
        }

        retireDocumentToken(message.documentToken);
        activeDocumentTokenRef.current = null;
        pendingDocumentTokenRef.current = null;
        readyAwaitingFrameLoadRef.current = null;
        frameLoadObservedRef.current = false;
        initializedReplayRef.current = null;
        replayOriginSelectionRef.current = null;
        setFallbackIssueId(null);
        setUnavailableLocatorIssueIds(new Set());
        setReplayConnectionState("loading");
        armReplayReadyTimeout();
        return;
      }

      if (message.type === "READY") {
        if (
          retiredDocumentTokensRef.current.has(message.documentToken) ||
          activeDocumentTokenRef.current === message.documentToken ||
          pendingDocumentTokenRef.current !== message.documentToken
        ) {
          return;
        }

        clearReplayReadyTimeout();
        activeDocumentTokenRef.current = message.documentToken;
        pendingDocumentTokenRef.current = null;
        readyAwaitingFrameLoadRef.current = frameLoadObservedRef.current
          ? null
          : message.documentToken;
        replayOriginSelectionRef.current = null;
        setReplayConnectionState("ready");
        setReplayReadyEpoch((current) => current + 1);
        return;
      }

      if (message.documentToken !== activeDocumentTokenRef.current) {
        return;
      }

      if (message.type === "ISSUE_SELECTED") {
        if (
          (message.issueId === null || replayIssues.some((issue) => issue.id === message.issueId)) &&
          message.issueId !== selectedIssueStateRef.current
        ) {
          selectedIssueStateRef.current = message.issueId;
          replayOriginSelectionRef.current = { issueId: message.issueId };
          onSelectIssue(message.issueId);
        }
        return;
      }

      if (message.type === "ISSUE_DETAIL_FALLBACK") {
        if (message.issueId === null) {
          setFallbackIssueId(null);
          return;
        }

        if (
          loadState === "ready" &&
          replayConnectionState === "ready" &&
          replayIssues.some((issue) => issue.id === message.issueId)
        ) {
          setFallbackIssueId(message.issueId);
        }
        return;
      }

      if (message.type === "LOCATOR_STATUS") {
        if (!replayIssues.some((issue) => issue.id === message.issueId)) {
          return;
        }

        setUnavailableLocatorIssueIds((current) => {
          const isUnavailable = message.status === "UNAVAILABLE";
          if (current.has(message.issueId) === isUnavailable) {
            return current;
          }

          const next = new Set(current);
          if (isUnavailable) {
            next.add(message.issueId);
          } else {
            next.delete(message.issueId);
          }
          return next;
        });
        return;
      }

    }

    window.addEventListener("message", handleReplayMessage);
    return () => window.removeEventListener("message", handleReplayMessage);
  }, [loadState, onSelectIssue, replayConnectionState, replayIssues]);

  useEffect(() => {
    if (replayConnectionState !== "ready") {
      return;
    }

    sendReplayViewScale();
  }, [
    replayConnectionState,
    replayReadyEpoch,
    replayViewportMetrics.scale,
    replayViewportMetrics.visualWidth
  ]);

  useEffect(() => {
    if (replayConnectionState !== "ready") {
      return;
    }

    sendInitialIssues();
  }, [
    replayConnectionState,
    replayIssuesSignature,
    replayReadyEpoch,
    replayViewportMetrics.scale,
    replayViewportMetrics.visualWidth
  ]);

  useEffect(() => {
    if (replayConnectionState !== "ready") {
      return;
    }

    const replayOriginSelection = replayOriginSelectionRef.current;
    replayOriginSelectionRef.current = null;
    if (replayOriginSelection?.issueId === selectedVisibleIssueId) {
      return;
    }

    postToReplay({
      source: DASHBOARD_REPLAY_SOURCE,
      type: "FOCUS_ISSUE",
      issueId: selectedVisibleIssueId
    });
  }, [replayConnectionState, selectedVisibleIssueId]);

  function handleFrameLoad() {
    frameLoadObservedRef.current = true;

    if (
      activeDocumentTokenRef.current !== null &&
      readyAwaitingFrameLoadRef.current === activeDocumentTokenRef.current
    ) {
      readyAwaitingFrameLoadRef.current = null;
      requestReplayDocumentState();
      return;
    }

    if (pendingDocumentTokenRef.current !== null) {
      requestReplayDocumentState();
      return;
    }

    clearReplayReadyTimeout();
    invalidateReplayDocumentSession();
    frameLoadObservedRef.current = true;
    setFallbackIssueId(null);
    setReplayConnectionState("loading");
    armReplayReadyTimeout();
    requestReplayDocumentState();
  }

  return (
    <article aria-labelledby="site-page-evidence-heading" className="dashboard-card site-page-evidence-card">
      <header className="site-page-evidence-header">
        <div>
          <h2 id="site-page-evidence-heading">페이지 검사 화면</h2>
          <p>
            {artifact
              ? `${formatDateTime(artifact.capturedAt)} 스캔 페이지 재현`
              : "문제가 발견된 요소를 재현된 페이지에서 직접 확인합니다"}
          </p>
        </div>

      </header>

      <div className="site-page-evidence-body">
        {loadState === "loading" && (
          <div className="site-page-evidence-loading" role="status" aria-live="polite">
            <span className="site-page-evidence-loading-bar" />
            <span>페이지 재현 화면을 불러오는 중입니다</span>
          </div>
        )}

        {loadState === "reconciling" && (
          <div className="site-page-evidence-empty" role="status" aria-live="polite">
            <MonitorOff aria-hidden="true" size={26} strokeWidth={1.8} />
            <div>
              <p className="site-page-evidence-empty-title">재현 페이지를 준비 중입니다</p>
              <p className="site-page-evidence-empty-description">
                분석 결과는 준비됐으며, 재현 페이지 업로드를 백그라운드에서 확인하고 있습니다.
              </p>
            </div>
          </div>
        )}

        {(loadState === "idle" || loadState === "empty") && (
          <EmptyEvidenceState loadState={loadState} onRetry={onRetry} />
        )}

        {loadState === "error" && (
          <div className="site-page-evidence-empty" role="alert">
            <MonitorOff aria-hidden="true" size={26} strokeWidth={1.8} />
            <div>
              <p className="site-page-evidence-empty-title">페이지 재현 화면을 불러오지 못했어요</p>
              <p className="site-page-evidence-empty-description">{errorMessage}</p>
              <button type="button" className="site-page-evidence-retry" onClick={onRetry}>
                <RefreshCw aria-hidden="true" size={15} />
                다시 시도
              </button>
            </div>
          </div>
        )}

        {loadState === "ready" && artifact && (
          <div className="site-page-evidence-grid">
            <div className="site-page-evidence-replay-column">
              <div
                ref={previewRef}
                className="site-page-evidence-preview"
                role="region"
                aria-label={`${targetName} 접근성 검사 페이지 재현 화면`}
                aria-busy={replayConnectionState === "loading"}
                data-connection-state={replayConnectionState}
                data-unavailable-locator-count={unavailableLocatorCount}
              >
                <iframe
                  key={`${artifact.id}:${frameRevision}`}
                  ref={iframeRef}
                  className="site-page-evidence-replay-frame"
                  data-replay-scale={replayScale.toFixed(4)}
                  data-replay-visual-width={replayViewportMetrics.visualWidth.toFixed(2)}
                  src={contentUrl ?? undefined}
                  style={replayFrameStyle}
                  title={`${targetName} 접근성 검사 페이지 재현`}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  onLoad={handleFrameLoad}
                  onError={() => {
                    clearReplayReadyTimeout();
                    setReplayConnectionState("error");
                  }}
                />

                {replayConnectionState === "loading" && (
                  <div className="site-page-evidence-replay-overlay" role="status" aria-live="polite">
                    <span className="site-page-evidence-loading-bar" />
                    <span>재현 페이지와 연결하는 중입니다</span>
                  </div>
                )}

                {replayConnectionState === "error" && (
                  <div className="site-page-evidence-replay-overlay" role="alert">
                    <MonitorOff aria-hidden="true" size={24} />
                    <span>재현 페이지와 연결하지 못했어요</span>
                    <button
                      type="button"
                      onClick={() => {
                        setReplayConnectionState("loading");
                        clearReplayReadyTimeout();
                        setFrameRevision((current) => current + 1);
                      }}
                    >
                      화면 다시 불러오기
                    </button>
                  </div>
                )}
              </div>

              {(replayConnectionState !== "ready" || unavailableLocatorCount > 0) && (
                <div className="site-page-evidence-replay-feedback">
                  {replayConnectionState !== "ready" ? (
                    <p
                      className="site-page-evidence-connection"
                      data-state={replayConnectionState}
                      role="status"
                      aria-live="polite"
                    >
                      {replayConnectionState === "error" ? "재현 페이지 연결 끊김" : "재현 페이지 연결 중"}
                    </p>
                  ) : (
                    <p className="site-page-evidence-locator-status" role="status" aria-live="polite">
                      문제 {unavailableLocatorCount}개의 위치를 재현 화면에 표시하지 못했습니다.{" "}
                      분석 결과에는 정상적으로 포함되어 있습니다.
                    </p>
                  )}
                </div>
              )}

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
                  <p className="site-page-evidence-fallback-detail__title">{fallbackIssue.title}</p>
                  {fallbackIssue.message && (
                    <p className="site-page-evidence-fallback-detail__message">{fallbackIssue.message}</p>
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
import "@/styles/page-evidence-layout.css";
