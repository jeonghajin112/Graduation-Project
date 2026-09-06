import { MonitorOff, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type {
  EvaluationCaptureMetadata,
  LiveReportSession
} from "@/types/accessibility-domain";

import { formatIssueCodeLabel } from "./constants";
import {
  getEvidenceFrameIdentity,
  getReplaySourceWidth,
  resolveEvidenceSource,
  shouldAwaitLiveDocumentHealthAfterFrameLoad,
  type EvidenceFrameKind
} from "./evidence-source";
import {
  consumeLiveReportAutomaticRecovery,
  createLiveReportAutomaticRecoveryState
} from "./live-report-recovery";
import {
  advancePageEvidenceLoadingPhase,
  getPageEvidenceLoadingProgress,
  type PageEvidenceLoadingPhase
} from "./page-evidence-loading-progress";
import {
  createLiveReportChallenge,
  createLiveReportConnectMessage,
  createLiveReportPortCommand,
  getLiveReportConnectTargetOrigin,
  parseLiveReportBridgeAvailableMessage,
  parseLiveReportSessionExhaustedEvent,
  parseLiveReportPortMessage
} from "./live-report-protocol";
import {
  DASHBOARD_REPLAY_SOURCE,
  REPLAY_VIEW_SCALE_MAX,
  REPLAY_VIEW_SCALE_MIN,
  REPLAY_VISUAL_WIDTH_MAX,
  isMeaningfulLiveDocumentHealth,
  isValidReplayViewportMetrics,
  parsePageReplayMessage,
  toPageReplayIssue,
  type DashboardToPageReplayMessage,
  type PageReplayToDashboardMessage,
  type ReplayViewportMetrics
} from "./page-replay-protocol";
import type { LocatorIssueState, LocatorReport, RecentIssueRow } from "./types";
import type { LiveReportSessionLoadState } from "./use-live-report-session";

type ReplayConnectionState = "loading" | "ready" | "error";

type LiveReportPortConnection = {
  challenge: string;
  documentToken: string | null;
  nextInboundSequence: number;
  nextOutboundSequence: number;
  port: MessagePort;
  sessionId: string;
  viewerOrigin: string;
};

type RenderedPageEvidenceCardProps = {
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

// The backend allows a single upstream fetch to take up to 10 seconds. Start this
// watchdog only after the iframe has actually loaded and leave enough time for
// client-side hydration plus a visible document-health sample.
const REPLAY_READY_TIMEOUT_MS = 15_000;
// Once the iframe load event fires, the injected bridge is already part of the
// document. A short ACK deadline catches JSON/error documents without making
// the user wait for the longer document-health watchdog.
const LIVE_REPORT_BRIDGE_ACK_TIMEOUT_MS = 4_000;
// The live proxy can legitimately spend up to roughly 50 seconds following the
// allowed redirect chain before the final document and its subresources finish.
// Keep this deadline above that server-side worst case so slow, valid sites get
// a fair chance to finish before the live-only error state is shown.
const REPLAY_FRAME_LOAD_TIMEOUT_MS = 120_000;
// Match the live viewer's bounded INIT_ISSUES input. Overflow remains in the
// unavailable list rather than waiting for statuses the viewer cannot send.
const LIVE_REPORT_ISSUE_LIMIT = 5_000;

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
  const [frameRevision, setFrameRevision] = useState(0);
  const [failedLiveSessionId, setFailedLiveSessionId] = useState<string | null>(null);
  const [fallbackIssueId, setFallbackIssueId] = useState<number | null>(null);
  const [replayConnectionState, setReplayConnectionState] = useState<ReplayConnectionState>("loading");
  const [replayLoadingPhase, setReplayLoadingPhase] = useState<PageEvidenceLoadingPhase>(
    "request-started"
  );
  const [replayReadyEpoch, setReplayReadyEpoch] = useState(0);
  const [locatorStates, setLocatorStates] = useState<Map<number, LocatorIssueState>>(() => new Map());
  const [replayViewportMetrics, setReplayViewportMetrics] = useState<ReplayViewportMetrics>({
    scale: 1,
    visualWidth: 0
  });
  const previewRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const activeFrameKindRef = useRef<EvidenceFrameKind>(null);
  const evaluationRequestIdRef = useRef(evaluationRequestId);
  const liveReportPortRef = useRef<LiveReportPortConnection | null>(null);
  const liveSessionRef = useRef<LiveReportSession | null>(liveSession);
  const retryLiveReportSessionRef = useRef(onRetryLiveSession);
  const liveReportBridgeConnectorRef = useRef<(viewerOrigin?: string) => void>(() => {});
  const replayMessageHandlerRef = useRef<(message: PageReplayToDashboardMessage) => void>(() => {});
  const activeDocumentTokenRef = useRef<string | null>(null);
  const pendingDocumentTokenRef = useRef<string | null>(null);
  const confirmedLiveDocumentTokenRef = useRef<string | null>(null);
  const readyAwaitingFrameLoadRef = useRef<string | null>(null);
  const retiredDocumentTokensRef = useRef(new Set<string>());
  const frameLoadObservedRef = useRef(false);
  const replayFrameLoadTimeoutRef = useRef<number | null>(null);
  const replayFrameLoadWatchdogEpochRef = useRef(0);
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
  const selectedIssueFocusRequestIdRef = useRef(0);
  const automaticLiveRecoveryRef = useRef(
    createLiveReportAutomaticRecoveryState(evaluationRequestId)
  );

  const replayIssues = useMemo(() => rows.map(toPageReplayIssue), [rows]);
  // Polling replaces row arrays even when their wire payload is unchanged. Reinitializing the
  // replay for an identity-only change destroys marker DOM, keyboard focus, and its tooltip link.
  const replayIssuesSignature = useMemo(() => JSON.stringify(replayIssues), [replayIssues]);
  const replayIssueIds = useMemo(
    () => new Set(replayIssues.map((issue) => issue.id)),
    [replayIssues]
  );
  const fallbackIssue = replayIssues.find((issue) => issue.id === fallbackIssueId) ?? null;
  const selectedVisibleIssueId = selectedIssueId !== null && replayIssueIds.has(selectedIssueId)
    ? selectedIssueId
    : null;
  const {
    frameKind: activeFrameKind,
    loadState: effectiveLoadState
  } = resolveEvidenceSource({
    hasLiveSession: liveSession !== null,
    hasPreviewRuntime: previewRuntimeUrl !== undefined,
    liveSessionFailed: liveSession !== null && failedLiveSessionId === liveSession.sessionId,
    liveSessionLoadState
  });
  const locatorReport = useMemo<LocatorReport>(() => {
    const connected = effectiveLoadState === "ready" && replayConnectionState === "ready";
    const issueLimit = activeFrameKind === "live" ? LIVE_REPORT_ISSUE_LIMIT : replayIssues.length;
    const issueStates: Record<number, LocatorIssueState> = {};
    const unavailableIssueIds: number[] = [];
    const recoverableHiddenIssueIds: number[] = [];
    if (connected) replayIssues.forEach((issue, index) => {
      const state: LocatorIssueState | undefined = index >= issueLimit
        ? { status: "UNAVAILABLE", reason: "ISSUE_LIMIT_EXCEEDED" }
        : locatorStates.get(issue.id);
      if (!state) return;
      issueStates[issue.id] = state;
      if (state.status === "HIDDEN_STATE" && state.recoverable === true) {
        recoverableHiddenIssueIds.push(issue.id);
      } else if (state.status === "UNAVAILABLE" || state.status === "HIDDEN_STATE") {
        unavailableIssueIds.push(issue.id);
      }
    });
    return {
      requestId: evaluationRequestId,
      issueIdsSignature: replayIssues.map((issue) => issue.id).join(","),
      state: effectiveLoadState === "error" ||
        (effectiveLoadState === "ready" && replayConnectionState === "error")
        ? "error"
        : connected && replayIssues.every((issue, index) =>
            index >= issueLimit || locatorStates.has(issue.id))
          ? "ready"
          : "loading",
      unavailableIssueIds,
      recoverableHiddenIssueIds,
      issueStates
    };
  }, [effectiveLoadState, replayConnectionState, evaluationRequestId, replayIssues, activeFrameKind,
    locatorStates]);
  const unavailableLocatorCount = locatorReport.unavailableIssueIds.length;
  const recoverableHiddenLocatorCount = locatorReport.recoverableHiddenIssueIds.length;

  useLayoutEffect(() => {
    onLocatorReportChange(locatorReport);
  }, [onLocatorReportChange, locatorReport]);

  const frameRuntimeUrl = activeFrameKind === "live"
    ? liveSession?.runtimeUrl ?? null
    : activeFrameKind === "preview"
      ? previewRuntimeUrl ?? null
      : null;
  const frameIdentity = getEvidenceFrameIdentity({
    frameKind: activeFrameKind,
    liveSessionId: liveSession?.sessionId ?? null,
    previewRuntimeUrl: previewRuntimeUrl ?? null
  });
  const loadingFrameKind = activeFrameKind ?? "live";
  const replayLoadingMessage = getPageEvidenceLoadingMessage({
    frameKind: loadingFrameKind,
    phase: replayLoadingPhase
  });
  const showsReplayLoadingOverlay = replayConnectionState === "loading"
    || (replayConnectionState === "ready" && replayLoadingPhase !== "complete");
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
    activeFrameKindRef.current = activeFrameKind;
  }, [activeFrameKind]);

  useLayoutEffect(() => {
    evaluationRequestIdRef.current = evaluationRequestId;
    liveSessionRef.current = liveSession;
    retryLiveReportSessionRef.current = onRetryLiveSession;
    liveReportBridgeConnectorRef.current = connectLiveReportBridge;
  });

  useLayoutEffect(() => {
    selectedIssueStateRef.current = selectedIssueId;
  }, [selectedIssueId]);

  useLayoutEffect(() => {
    if (automaticLiveRecoveryRef.current.requestId !== evaluationRequestId) {
      automaticLiveRecoveryRef.current = createLiveReportAutomaticRecoveryState(
        evaluationRequestId
      );
    }
  }, [evaluationRequestId]);

  function advanceReplayLoadingPhase(nextPhase: PageEvidenceLoadingPhase) {
    setReplayLoadingPhase((currentPhase) =>
      advancePageEvidenceLoadingPhase(currentPhase, nextPhase)
    );
  }

  function clearReplayFrameLoadTimeout() {
    replayFrameLoadWatchdogEpochRef.current += 1;
    if (replayFrameLoadTimeoutRef.current !== null) {
      window.clearTimeout(replayFrameLoadTimeoutRef.current);
      replayFrameLoadTimeoutRef.current = null;
    }
  }

  function clearReplayReadyTimeout() {
    replayReadyWatchdogEpochRef.current += 1;
    if (replayReadyTimeoutRef.current !== null) {
      window.clearTimeout(replayReadyTimeoutRef.current);
      replayReadyTimeoutRef.current = null;
    }
  }

  function closeLiveReportPort() {
    const connection = liveReportPortRef.current;
    if (!connection) {
      return;
    }
    liveReportPortRef.current = null;
    connection.port.onmessage = null;
    connection.port.onmessageerror = null;
    connection.port.close();
  }

  function failLiveReportConnection(sessionId: string) {
    if (liveReportPortRef.current?.sessionId === sessionId) {
      closeLiveReportPort();
    }
    clearReplayFrameLoadTimeout();
    clearReplayReadyTimeout();
    setFallbackIssueId(null);
    if (
      activeFrameKindRef.current === "live" &&
      liveSessionRef.current?.sessionId === sessionId
    ) {
      const currentRequestId = evaluationRequestIdRef.current;
      const recovery = consumeLiveReportAutomaticRecovery(
        automaticLiveRecoveryRef.current,
        currentRequestId
      );
      automaticLiveRecoveryRef.current = recovery.nextState;
      setFailedLiveSessionId(sessionId);
      setReplayLoadingPhase("request-started");
      setReplayConnectionState("loading");
      if (recovery.shouldRetry) {
        retryLiveReportSessionRef.current();
      }
    }
  }

  function armReplayFrameLoadTimeout() {
    clearReplayFrameLoadTimeout();
    const watchdogEpoch = replayFrameLoadWatchdogEpochRef.current;
    replayFrameLoadTimeoutRef.current = window.setTimeout(() => {
      if (replayFrameLoadWatchdogEpochRef.current !== watchdogEpoch) {
        return;
      }
      replayFrameLoadTimeoutRef.current = null;
      setFallbackIssueId(null);
      const activeSession = liveSessionRef.current;
      if (activeFrameKindRef.current === "live" && activeSession !== null) {
        failLiveReportConnection(activeSession.sessionId);
      } else {
        setReplayConnectionState("error");
      }
    }, REPLAY_FRAME_LOAD_TIMEOUT_MS);
  }

  function armLiveReportBridgeAckTimeout(sessionId: string) {
    clearReplayReadyTimeout();
    const watchdogEpoch = replayReadyWatchdogEpochRef.current;
    replayReadyTimeoutRef.current = window.setTimeout(() => {
      if (replayReadyWatchdogEpochRef.current !== watchdogEpoch) {
        return;
      }
      replayReadyTimeoutRef.current = null;
      const connection = liveReportPortRef.current;
      if (
        activeFrameKindRef.current === "live" &&
        liveSessionRef.current?.sessionId === sessionId &&
        (connection?.sessionId !== sessionId || connection.documentToken === null)
      ) {
        failLiveReportConnection(sessionId);
      }
    }, LIVE_REPORT_BRIDGE_ACK_TIMEOUT_MS);
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
      const activeSession = liveSessionRef.current;
      if (activeFrameKindRef.current === "live" && activeSession !== null) {
        failLiveReportConnection(activeSession.sessionId);
      } else {
        setReplayConnectionState((current) => (current === "ready" ? current : "error"));
      }
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
    confirmedLiveDocumentTokenRef.current = null;
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
    if (activeFrameKindRef.current === "live" && liveSession !== null) {
      const connection = liveReportPortRef.current;
      if (
        !connection ||
        connection.sessionId !== liveSession.sessionId ||
        connection.documentToken === null
      ) {
        return;
      }
      const sequence = connection.nextOutboundSequence;
      connection.nextOutboundSequence += 1;
      try {
        connection.port.postMessage(createLiveReportPortCommand(message, {
          session: liveSession,
          challenge: connection.challenge,
          documentToken: connection.documentToken,
          sequence
        }));
      } catch {
        failLiveReportConnection(liveSession.sessionId);
      }
      return;
    }

    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) {
      return;
    }
    frameWindow.postMessage(message, "*");
  }

  function connectLiveReportBridge(viewerOrigin?: string) {
    const frameWindow = iframeRef.current?.contentWindow;
    const session = liveSession;
    if (!frameWindow || !session || activeFrameKindRef.current !== "live") {
      return;
    }

    let targetOrigin: string;
    try {
      targetOrigin = getLiveReportConnectTargetOrigin(session, viewerOrigin);
    } catch {
      failLiveReportConnection(session.sessionId);
      return;
    }

    closeLiveReportPort();

    let challenge: string;
    try {
      challenge = createLiveReportChallenge();
    } catch {
      failLiveReportConnection(session.sessionId);
      return;
    }

    let channel: MessageChannel;
    try {
      channel = new MessageChannel();
    } catch {
      failLiveReportConnection(session.sessionId);
      return;
    }
    const connection: LiveReportPortConnection = {
      challenge,
      documentToken: null,
      nextInboundSequence: 1,
      nextOutboundSequence: 1,
      port: channel.port1,
      sessionId: session.sessionId,
      viewerOrigin: targetOrigin
    };
    liveReportPortRef.current = connection;

    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (liveReportPortRef.current !== connection) {
        return;
      }

      const message = parseLiveReportPortMessage(event.data, {
        session,
        challenge,
        expectedSequence: connection.nextInboundSequence,
        expectedDocumentToken: connection.documentToken
      });
      if (!message) {
        failLiveReportConnection(session.sessionId);
        return;
      }

      connection.nextInboundSequence += 1;
      if (message.type === "ACK") {
        connection.documentToken = message.documentToken;
        advanceReplayLoadingPhase("bridge-connected");
        armReplayReadyTimeout();
        requestReplayDocumentState();
        return;
      }

      replayMessageHandlerRef.current(message.payload);
    };
    channel.port1.onmessageerror = () => failLiveReportConnection(session.sessionId);
    channel.port1.start();
    armLiveReportBridgeAckTimeout(session.sessionId);

    try {
      frameWindow.postMessage(
        createLiveReportConnectMessage(session, challenge),
        targetOrigin,
        [channel.port2]
      );
    } catch {
      failLiveReportConnection(session.sessionId);
    }
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
    setFailedLiveSessionId(null);
  }, [liveSession?.sessionId]);

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

  useLayoutEffect(() => {
    clearReplayFrameLoadTimeout();
    clearReplayReadyTimeout();
    closeLiveReportPort();
    invalidateReplayDocumentSession({ resetRetiredTokens: true });
    setFallbackIssueId(null);
    setLocatorStates(new Map());
    setReplayLoadingPhase(
      effectiveLoadState === "ready" && activeFrameKind !== null && frameRuntimeUrl !== null
        ? "source-ready"
        : "request-started"
    );
    setReplayConnectionState("loading");

    if (effectiveLoadState === "ready" && activeFrameKind !== null && frameRuntimeUrl !== null) {
      armReplayFrameLoadTimeout();
    }

    return () => {
      clearReplayFrameLoadTimeout();
      clearReplayReadyTimeout();
      closeLiveReportPort();
      invalidateReplayDocumentSession();
    };
  }, [effectiveLoadState, frameIdentity, frameRevision, frameRuntimeUrl]);

  useEffect(() => {
    setFallbackIssueId(null);
  }, [frameRevision]);

  useLayoutEffect(() => {
    setFallbackIssueId(null);
    setLocatorStates(new Map());
  }, [replayIssuesSignature]);

  useEffect(() => {
    if (effectiveLoadState !== "ready" || replayConnectionState !== "ready") {
      setFallbackIssueId(null);
    }
  }, [effectiveLoadState, replayConnectionState]);

  useEffect(() => {
    return () => {
      clearReplayFrameLoadTimeout();
      clearReplayReadyTimeout();
      closeLiveReportPort();
    };
  }, []);

  function handleReplayProtocolMessage(message: PageReplayToDashboardMessage) {
    if (message.type === "DOCUMENT_LOADING") {
      if (
        retiredDocumentTokensRef.current.has(message.documentToken) ||
        pendingDocumentTokenRef.current === message.documentToken ||
        activeDocumentTokenRef.current === message.documentToken
      ) {
        return;
      }

      const replacesKnownDocument =
        activeDocumentTokenRef.current !== null || pendingDocumentTokenRef.current !== null;
      retireDocumentToken(activeDocumentTokenRef.current);
      retireDocumentToken(pendingDocumentTokenRef.current);
      activeDocumentTokenRef.current = null;
      pendingDocumentTokenRef.current = message.documentToken;
      confirmedLiveDocumentTokenRef.current = null;
      readyAwaitingFrameLoadRef.current = null;
      frameLoadObservedRef.current = false;
      initializedReplayRef.current = null;
      replayOriginSelectionRef.current = null;
      setFallbackIssueId(null);
      setLocatorStates(new Map());
      if (replacesKnownDocument) {
        setReplayLoadingPhase("source-ready");
      } else {
        advanceReplayLoadingPhase("source-ready");
      }
      setReplayConnectionState("loading");
      clearReplayReadyTimeout();
      armReplayFrameLoadTimeout();
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
      confirmedLiveDocumentTokenRef.current = null;
      readyAwaitingFrameLoadRef.current = null;
      frameLoadObservedRef.current = false;
      initializedReplayRef.current = null;
      replayOriginSelectionRef.current = null;
      setFallbackIssueId(null);
      setLocatorStates(new Map());
      setReplayLoadingPhase("source-ready");
      setReplayConnectionState("loading");
      clearReplayReadyTimeout();
      armReplayFrameLoadTimeout();
      if (activeFrameKindRef.current === "live") {
        closeLiveReportPort();
      }
      return;
    }

    if (message.type === "READY") {
      if (
        retiredDocumentTokensRef.current.has(message.documentToken) ||
        activeDocumentTokenRef.current === message.documentToken ||
        (pendingDocumentTokenRef.current !== null &&
          pendingDocumentTokenRef.current !== message.documentToken)
      ) {
        return;
      }

      activeDocumentTokenRef.current = message.documentToken;
      pendingDocumentTokenRef.current = null;
      // A trusted bridge READY proves that the document executed successfully.
      // The iframe load event may still be waiting on slow subresources, so it
      // must no longer be allowed to trip the coarse frame-load watchdog.
      clearReplayFrameLoadTimeout();
      readyAwaitingFrameLoadRef.current = frameLoadObservedRef.current
        ? null
        : message.documentToken;
      replayOriginSelectionRef.current = null;
      advanceReplayLoadingPhase("document-ready");
      if (activeFrameKindRef.current === "live") {
        // A live bridge can initialize even when the proxied page has not painted any
        // meaningful content. Keep the loading shield in place until the bridge reports
        // actual visible DOM, and give late client rendering a fresh health window.
        setReplayConnectionState("loading");
        armReplayReadyTimeout();
      } else {
        clearReplayReadyTimeout();
        advanceReplayLoadingPhase("complete");
        setReplayConnectionState("ready");
        setReplayReadyEpoch((current) => current + 1);
      }
      return;
    }

    if (message.type === "DOCUMENT_HEALTH") {
      if (
        activeFrameKindRef.current !== "live" ||
        message.documentToken !== activeDocumentTokenRef.current ||
        !isMeaningfulLiveDocumentHealth(message)
      ) {
        return;
      }

      // A late iframe load may have armed a new watchdog after this document was
      // already confirmed. Every valid health replay must cancel that watchdog,
      // including duplicate reports for the active document token.
      clearReplayReadyTimeout();
      if (confirmedLiveDocumentTokenRef.current === message.documentToken) {
        return;
      }
      confirmedLiveDocumentTokenRef.current = message.documentToken;
      advanceReplayLoadingPhase("complete");
      setReplayConnectionState("ready");
      setReplayReadyEpoch((current) => current + 1);
      return;
    }

    if (message.documentToken !== activeDocumentTokenRef.current) {
      return;
    }

    if (message.type === "ISSUE_SELECTED") {
      if (
        (message.issueId === null || replayIssueIds.has(message.issueId)) &&
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
        effectiveLoadState === "ready" &&
        replayConnectionState === "ready" &&
        replayIssueIds.has(message.issueId)
      ) {
        setFallbackIssueId(message.issueId);
      }
      return;
    }

    if (message.type === "LOCATOR_STATUS") {
      if (!replayIssueIds.has(message.issueId)) {
        return;
      }

      setLocatorStates((current) => {
        const next: LocatorIssueState = {
          status: message.status,
          reason: message.reason,
          recoverable: message.recoverable
        };
        const previous = current.get(message.issueId);
        if (previous?.status === next.status && previous.reason === next.reason &&
            previous.recoverable === next.recoverable) return current;
        return new Map(current).set(message.issueId, next);
      });
    }
  }

  useLayoutEffect(() => {
    replayMessageHandlerRef.current = handleReplayProtocolMessage;
  });

  useLayoutEffect(() => {
    function handleReplayMessage(event: MessageEvent<unknown>) {
      const iframe = iframeRef.current;
      if (
        !iframe ||
        event.source !== iframe.contentWindow
      ) {
        return;
      }

      if (activeFrameKindRef.current === "live") {
        const session = liveSessionRef.current;
        if (!session) {
          return;
        }
        if (
          parseLiveReportSessionExhaustedEvent(event.data, session, event.origin) !== null
        ) {
          failLiveReportConnection(session.sessionId);
          return;
        }
        const available = parseLiveReportBridgeAvailableMessage(event.data, session.sessionId);
        let targetOrigin: string;
        try {
          targetOrigin = getLiveReportConnectTargetOrigin(session, event.origin);
        } catch {
          return;
        }
        if (!available) {
          return;
        }
        const connection = liveReportPortRef.current;
        if (
          connection?.sessionId === session.sessionId &&
          connection.viewerOrigin === targetOrigin &&
          (connection.documentToken === null || connection.documentToken === available.documentToken)
        ) {
          return;
        }
        liveReportBridgeConnectorRef.current(targetOrigin);
        return;
      }

      if (activeFrameKindRef.current !== "preview") {
        return;
      }

      if (event.origin !== "null") {
        return;
      }

      const message = parsePageReplayMessage(event.data);
      if (message) {
        replayMessageHandlerRef.current(message);
      }
    }

    window.addEventListener("message", handleReplayMessage);
    return () => window.removeEventListener("message", handleReplayMessage);
  }, []);

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

  // Consume the iframe selection in its commit, before another message can replace
  // its origin marker while a passive effect is still waiting to run.
  useLayoutEffect(() => {
    if (replayConnectionState !== "ready") {
      return;
    }

    const explicitlyRequested =
      selectedIssueFocusRequestIdRef.current !== selectedIssueFocusRequestId;
    selectedIssueFocusRequestIdRef.current = selectedIssueFocusRequestId;
    const replayOriginSelection = replayOriginSelectionRef.current;
    replayOriginSelectionRef.current = null;
    if (!explicitlyRequested && replayOriginSelection?.issueId === selectedVisibleIssueId) {
      return;
    }

    postToReplay({
      source: DASHBOARD_REPLAY_SOURCE,
      type: "FOCUS_ISSUE",
      issueId: selectedVisibleIssueId
    });
  }, [replayConnectionState, selectedIssueFocusRequestId, selectedVisibleIssueId]);

  function handleFrameLoad() {
    clearReplayFrameLoadTimeout();
    advanceReplayLoadingPhase("frame-loaded");
    if (activeFrameKindRef.current === "live") {
      frameLoadObservedRef.current = true;
      const activeSession = liveSessionRef.current;
      const existingConnection = liveReportPortRef.current;
      if (
        activeSession !== null &&
        existingConnection?.sessionId === activeSession.sessionId
      ) {
        if (existingConnection.documentToken !== null) {
          if (!shouldAwaitLiveDocumentHealthAfterFrameLoad({
            confirmedDocumentToken: confirmedLiveDocumentTokenRef.current,
            documentToken: existingConnection.documentToken
          })) {
            clearReplayReadyTimeout();
            return;
          }
          armReplayReadyTimeout();
          requestReplayDocumentState();
        } else {
          armLiveReportBridgeAckTimeout(activeSession.sessionId);
        }
        return;
      }
      clearReplayReadyTimeout();
      closeLiveReportPort();
      invalidateReplayDocumentSession();
      setFallbackIssueId(null);
      setLocatorStates(new Map());
      setReplayConnectionState("loading");
      connectLiveReportBridge();
      return;
    }

    frameLoadObservedRef.current = true;

    if (
      activeDocumentTokenRef.current !== null &&
      readyAwaitingFrameLoadRef.current === activeDocumentTokenRef.current
    ) {
      readyAwaitingFrameLoadRef.current = null;
      armReplayReadyTimeout();
      requestReplayDocumentState();
      return;
    }

    if (pendingDocumentTokenRef.current !== null) {
      armReplayReadyTimeout();
      requestReplayDocumentState();
      return;
    }

    clearReplayReadyTimeout();
    invalidateReplayDocumentSession();
    frameLoadObservedRef.current = true;
    setFallbackIssueId(null);
    setLocatorStates(new Map());
    setReplayConnectionState("loading");
    armReplayReadyTimeout();
    requestReplayDocumentState();
  }

  return (
    <article aria-labelledby="site-page-evidence-heading" className="dashboard-card site-page-evidence-card">
      {/* 제목은 화면에서 숨기고 접근 가능한 이름으로만 남긴다 */}
      <h2 id="site-page-evidence-heading" className="sr-only">페이지 검사 화면</h2>

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
                <iframe
                  key={`${frameIdentity ?? "none"}:${frameRevision}`}
                  ref={iframeRef}
                  className="site-page-evidence-replay-frame"
                  data-replay-scale={replayScale.toFixed(4)}
                  data-replay-visual-width={replayViewportMetrics.visualWidth.toFixed(2)}
                  data-report-mode={activeFrameKind}
                  src={frameRuntimeUrl}
                  style={replayFrameStyle}
                  title={`${targetName} 접근성 검사 페이지 ${activeFrameKind === "live" ? "동적 보기" : "제품 미리보기"}`}
                  sandbox={activeFrameKind === "live"
                    ? "allow-scripts allow-same-origin allow-forms"
                    : "allow-scripts"}
                  referrerPolicy="no-referrer"
                  loading={activeFrameKind === "live" ? "eager" : "lazy"}
                  onLoad={handleFrameLoad}
                  onError={() => {
                    clearReplayFrameLoadTimeout();
                    clearReplayReadyTimeout();
                    if (activeFrameKindRef.current === "live" && liveSession !== null) {
                      failLiveReportConnection(liveSession.sessionId);
                    } else {
                      setReplayConnectionState("error");
                    }
                  }}
                />

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
                      onClick={() => {
                        setReplayLoadingPhase(
                          activeFrameKindRef.current === "live"
                            ? "request-started"
                            : "source-ready"
                        );
                        setReplayConnectionState("loading");
                        clearReplayReadyTimeout();
                        if (activeFrameKindRef.current === "live") {
                          // A live session can have exhausted its bounded request
                          // or byte budget. Retrying the same URL can never heal
                          // that state, so ask the owner to create a fresh session.
                          automaticLiveRecoveryRef.current =
                            createLiveReportAutomaticRecoveryState(evaluationRequestId);
                          onRetryLiveSession();
                        } else {
                          setFrameRevision((current) => current + 1);
                        }
                      }}
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
