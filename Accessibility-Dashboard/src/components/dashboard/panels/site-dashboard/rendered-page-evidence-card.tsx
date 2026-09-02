import { MonitorOff, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getEvaluationArtifactContentUrl } from "@/services/backend-api";
import type { EvaluationArtifact, LiveReportSession } from "@/types/accessibility-domain";

import { formatIssueCodeLabel } from "./constants";
import { getReplaySourceWidth, resolveEvidenceSource } from "./evidence-source";
import {
  consumeLiveReportAutomaticRecovery,
  createLiveReportAutomaticRecoveryState
} from "./live-report-recovery";
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
import type { RecentIssueRow } from "./types";
import type { EvaluationArtifactLoadState } from "./use-evaluation-artifact";
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
  artifact: EvaluationArtifact | null;
  artifactContentUrl?: string;
  errorMessage: string | null;
  evaluationRequestId: number | null;
  loadState: EvaluationArtifactLoadState;
  liveSession: LiveReportSession | null;
  liveSessionErrorMessage: string | null;
  liveSessionLoadState: LiveReportSessionLoadState;
  onRetry: () => void;
  onRetryLiveSession: () => void;
  onSelectIssue: (issueId: number | null) => void;
  rows: RecentIssueRow[];
  selectedIssueId: number | null;
  targetName: string;
};

// The backend allows a single upstream fetch to take up to 10 seconds. Start this
// watchdog only after the iframe has actually loaded and leave enough time for
// client-side hydration plus four stable document-health samples.
const REPLAY_READY_TIMEOUT_MS = 15_000;
// Once the iframe load event fires, the injected bridge is already part of the
// document. A short ACK deadline catches JSON/error documents without making
// the user wait for the longer document-health watchdog.
const LIVE_REPORT_BRIDGE_ACK_TIMEOUT_MS = 4_000;
// The live proxy can legitimately spend up to roughly 50 seconds following the
// allowed redirect chain before the final document and its subresources finish.
// Keep this deadline above that server-side worst case so slow, valid sites do
// not get replaced by the stored artifact prematurely.
const REPLAY_FRAME_LOAD_TIMEOUT_MS = 120_000;
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
  evaluationRequestId,
  loadState,
  liveSession,
  liveSessionErrorMessage,
  liveSessionLoadState,
  onRetry,
  onRetryLiveSession,
  onSelectIssue,
  rows,
  selectedIssueId,
  targetName
}: RenderedPageEvidenceCardProps) {
  const [frameRevision, setFrameRevision] = useState(0);
  const [failedLiveSessionId, setFailedLiveSessionId] = useState<string | null>(null);
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
  const activeFrameKindRef = useRef<"artifact" | "live" | null>(null);
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
  const unavailableLocatorCount = replayIssues.reduce(
    (count, issue) => count + Number(unavailableLocatorIssueIds.has(issue.id)),
    0
  );
  const artifactContentSource = artifact
    ? artifactContentUrl ?? getEvaluationArtifactContentUrl(artifact.contentUrl)
    : null;
  const {
    frameKind: activeFrameKind,
    loadState: effectiveLoadState,
    usesLiveSession,
    waitsForLiveSession
  } = resolveEvidenceSource({
    artifactLoadState: loadState,
    hasArtifact: artifact !== null,
    hasLiveSession: liveSession !== null,
    liveSessionFailed: liveSession !== null && failedLiveSessionId === liveSession.sessionId,
    liveSessionLoadState
  });
  const contentUrl = activeFrameKind === "live"
    ? liveSession?.runtimeUrl ?? null
    : activeFrameKind === "artifact"
      ? artifactContentSource
      : null;
  const replaySourceWidth = getReplaySourceWidth(artifact, activeFrameKind);
  const replayScale = replayViewportMetrics.scale;
  const replayFrameStyle = activeFrameKind !== null && artifact && replayScale < 0.999
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
  }, [artifact?.id, effectiveLoadState, liveSession?.sessionId, replaySourceWidth]);

  useLayoutEffect(() => {
    clearReplayFrameLoadTimeout();
    clearReplayReadyTimeout();
    closeLiveReportPort();
    invalidateReplayDocumentSession({ resetRetiredTokens: true });
    setFallbackIssueId(null);
    setUnavailableLocatorIssueIds(new Set());
    setReplayConnectionState("loading");

    if (effectiveLoadState === "ready" && activeFrameKind !== null && contentUrl !== null) {
      armReplayFrameLoadTimeout();
    }

    return () => {
      clearReplayFrameLoadTimeout();
      clearReplayReadyTimeout();
      closeLiveReportPort();
      invalidateReplayDocumentSession();
    };
  }, [activeFrameKind, artifact?.id, contentUrl, effectiveLoadState, frameRevision, liveSession?.sessionId]);

  useEffect(() => {
    setFallbackIssueId(null);
  }, [frameRevision]);

  useEffect(() => {
    setFallbackIssueId(null);
    setUnavailableLocatorIssueIds(new Set());
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
      setUnavailableLocatorIssueIds(new Set());
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
      setUnavailableLocatorIssueIds(new Set());
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
        pendingDocumentTokenRef.current !== message.documentToken
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
      if (activeFrameKindRef.current === "live") {
        // A live bridge can initialize even when the proxied page has not painted any
        // meaningful content. Keep the loading shield in place until the bridge reports
        // actual visible DOM, and give late client rendering a fresh health window.
        setReplayConnectionState("loading");
        armReplayReadyTimeout();
      } else {
        clearReplayReadyTimeout();
        setReplayConnectionState("ready");
        setReplayReadyEpoch((current) => current + 1);
      }
      return;
    }

    if (message.type === "DOCUMENT_HEALTH") {
      if (
        activeFrameKindRef.current !== "live" ||
        message.documentToken !== activeDocumentTokenRef.current ||
        !isMeaningfulLiveDocumentHealth(message) ||
        confirmedLiveDocumentTokenRef.current === message.documentToken
      ) {
        return;
      }

      confirmedLiveDocumentTokenRef.current = message.documentToken;
      clearReplayReadyTimeout();
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

      if (activeFrameKindRef.current !== "artifact") {
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
    clearReplayFrameLoadTimeout();
    if (activeFrameKindRef.current === "live") {
      frameLoadObservedRef.current = true;
      const activeSession = liveSessionRef.current;
      const existingConnection = liveReportPortRef.current;
      if (
        activeSession !== null &&
        existingConnection?.sessionId === activeSession.sessionId
      ) {
        if (existingConnection.documentToken !== null) {
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
      setUnavailableLocatorIssueIds(new Set());
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
    setReplayConnectionState("loading");
    armReplayReadyTimeout();
    requestReplayDocumentState();
  }

  return (
    <article aria-labelledby="site-page-evidence-heading" className="dashboard-card site-page-evidence-card">
      <header className="site-page-evidence-header">
        <div>
          <h2 id="site-page-evidence-heading">페이지 검사 화면</h2>
          <p>문제가 발견된 요소를 재현된 페이지에서 직접 확인합니다</p>
        </div>

      </header>

      <div className="site-page-evidence-body">
        {effectiveLoadState === "loading" && (
          <div className="site-page-evidence-loading" role="status" aria-live="polite">
            <span className="site-page-evidence-loading-bar" />
            <span>
              {waitsForLiveSession
                ? "동적 검사 화면을 준비하는 중입니다"
                : "페이지 재현 화면을 불러오는 중입니다"}
            </span>
          </div>
        )}

        {effectiveLoadState === "reconciling" && (
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

        {(effectiveLoadState === "idle" || effectiveLoadState === "empty") && (
          <EmptyEvidenceState loadState={effectiveLoadState} onRetry={onRetry} />
        )}

        {effectiveLoadState === "error" && (
          <div className="site-page-evidence-empty" role="alert">
            <MonitorOff aria-hidden="true" size={26} strokeWidth={1.8} />
            <div>
              <p className="site-page-evidence-empty-title">페이지 재현 화면을 불러오지 못했어요</p>
              <p className="site-page-evidence-empty-description">
                {errorMessage ?? liveSessionErrorMessage ??
                  "동적 검사 화면과 저장된 재현 화면을 모두 불러오지 못했습니다."}
              </p>
              <button type="button" className="site-page-evidence-retry" onClick={onRetry}>
                <RefreshCw aria-hidden="true" size={15} />
                다시 시도
              </button>
            </div>
          </div>
        )}

        {effectiveLoadState === "ready" && activeFrameKind !== null && contentUrl !== null && (
          <div className="site-page-evidence-grid">
            <div className="site-page-evidence-replay-column">
              <div
                ref={previewRef}
                className="site-page-evidence-preview"
                role="region"
                aria-label={`${targetName} 접근성 검사 ${activeFrameKind === "live" ? "동적" : "재현"} 화면`}
                aria-busy={replayConnectionState === "loading"}
                data-connection-state={replayConnectionState}
                data-unavailable-locator-count={unavailableLocatorCount}
              >
                <iframe
                  key={`${activeFrameKind}:${liveSession?.sessionId ?? artifact?.id ?? "none"}:${frameRevision}`}
                  ref={iframeRef}
                  className="site-page-evidence-replay-frame"
                  data-replay-scale={replayScale.toFixed(4)}
                  data-replay-visual-width={replayViewportMetrics.visualWidth.toFixed(2)}
                  data-report-mode={activeFrameKind}
                  src={contentUrl ?? undefined}
                  style={replayFrameStyle}
                  title={`${targetName} 접근성 검사 페이지 ${activeFrameKind === "live" ? "동적 보기" : "재현"}`}
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

              {!usesLiveSession &&
                (liveSessionLoadState === "error" || failedLiveSessionId !== null) &&
                activeFrameKind === "artifact" && (
                  <div className="site-page-evidence-connection" role="status" aria-live="polite">
                    <span>동적 화면에 연결할 수 없어 저장된 재현 화면을 표시합니다.</span>
                    <button
                      type="button"
                      className="site-page-evidence-retry"
                      onClick={() => {
                        automaticLiveRecoveryRef.current =
                          createLiveReportAutomaticRecoveryState(evaluationRequestId);
                        onRetryLiveSession();
                      }}
                    >
                      <RefreshCw aria-hidden="true" size={14} />
                      동적 화면 다시 연결
                    </button>
                  </div>
                )}

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
