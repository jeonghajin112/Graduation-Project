import {
  Code2,
  Eye,
  EyeOff,
  MonitorOff,
  RefreshCw
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getEvaluationArtifactContentUrl } from "@/services/backend-api";
import type { EvaluationArtifact } from "@/types/accessibility-domain";

import { formatDateTime } from "../../shared/utils";
import {
  DASHBOARD_REPLAY_SOURCE,
  parsePageReplayMessage,
  toPageReplayIssue,
  type DashboardToPageReplayMessage
} from "./page-replay-protocol";
import { hasUsableIssueLocator } from "./issue-locator";
import type { RecentIssueRow } from "./types";
import type { EvaluationArtifactLoadState } from "./use-evaluation-artifact";

type EvidenceView = "page" | "code";
type ReplayConnectionState = "loading" | "ready" | "error";

type RenderedPageEvidenceCardProps = {
  artifact: EvaluationArtifact | null;
  errorMessage: string | null;
  loadState: EvaluationArtifactLoadState;
  onRetry: () => void;
  onSelectIssue: (issueId: number | null) => void;
  rows: RecentIssueRow[];
  selectedIssueId: number | null;
  targetName: string;
};

const REPLAY_READY_TIMEOUT_MS = 8_000;

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
  errorMessage,
  loadState,
  onRetry,
  onSelectIssue,
  rows,
  selectedIssueId,
  targetName
}: RenderedPageEvidenceCardProps) {
  const [activeView, setActiveView] = useState<EvidenceView>("page");
  const [frameRevision, setFrameRevision] = useState(0);
  const [fallbackIssueId, setFallbackIssueId] = useState<number | null>(null);
  const [markersVisible, setMarkersVisible] = useState(true);
  const [replayConnectionState, setReplayConnectionState] = useState<ReplayConnectionState>("loading");
  const [replayReadyEpoch, setReplayReadyEpoch] = useState(0);
  const [severityFilter, setSeverityFilter] = useState<RecentIssueRow["severity"]["key"] | "ALL">("ALL");
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
  const replayOriginSelectionRef = useRef<{ issueId: number | null } | null>(null);
  const selectedIssueStateRef = useRef(selectedIssueId);
  selectedIssueStateRef.current = selectedIssueId;

  const visibleRows = useMemo(
    () =>
      severityFilter === "ALL"
        ? rows
        : rows.filter((row) => row.severity.key === severityFilter),
    [rows, severityFilter]
  );
  const replayIssues = useMemo(() => visibleRows.map(toPageReplayIssue), [visibleRows]);
  // Polling replaces row arrays even when their wire payload is unchanged. Reinitializing the
  // replay for an identity-only change destroys marker DOM, keyboard focus, and its tooltip link.
  const replayIssuesSignature = useMemo(() => JSON.stringify(replayIssues), [replayIssues]);
  const fallbackIssue = replayIssues.find((issue) => issue.id === fallbackIssueId) ?? null;
  const selectedRow = visibleRows.find(({ issue }) => issue.id === selectedIssueId) ?? null;
  const selectedVisibleIssueId = replayIssues.some((issue) => issue.id === selectedIssueId)
    ? selectedIssueId
    : null;
  const contentUrl = artifact ? getEvaluationArtifactContentUrl(artifact.contentUrl) : null;

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

  function sendInitialIssues() {
    const documentToken = activeDocumentTokenRef.current;
    const initializedReplay = initializedReplayRef.current;
    if (
      documentToken === null ||
      (initializedReplay?.documentToken === documentToken &&
        initializedReplay.issuesSignature === replayIssuesSignature)
    ) {
      return;
    }

    postToReplay({
      source: DASHBOARD_REPLAY_SOURCE,
      type: "INIT_ISSUES",
      issues: replayIssues,
      selectedIssueId: selectedVisibleIssueId,
      markersVisible
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
    clearReplayReadyTimeout();
    invalidateReplayDocumentSession({ resetRetiredTokens: true });
    setFallbackIssueId(null);
    setReplayConnectionState("loading");

    if (loadState === "ready" && artifact && activeView === "page") {
      armReplayReadyTimeout();
    }

    return () => {
      clearReplayReadyTimeout();
      invalidateReplayDocumentSession();
    };
  }, [activeView, artifact?.contentUrl, artifact?.id, frameRevision, loadState]);

  useEffect(() => {
    setFallbackIssueId(null);
  }, [frameRevision]);

  useEffect(() => {
    setFallbackIssueId(null);
  }, [replayIssuesSignature]);

  useEffect(() => {
    if (activeView !== "page") {
      clearReplayReadyTimeout();
    }
  }, [activeView]);

  useEffect(() => {
    if (
      loadState !== "ready" ||
      activeView !== "page" ||
      !markersVisible ||
      replayConnectionState !== "ready"
    ) {
      setFallbackIssueId(null);
    }
  }, [activeView, loadState, markersVisible, replayConnectionState]);

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
          activeView === "page" &&
          markersVisible &&
          replayConnectionState === "ready" &&
          replayIssues.some((issue) => issue.id === message.issueId)
        ) {
          setFallbackIssueId(message.issueId);
        }
        return;
      }

      if (message.type === "LOCATOR_STATUS") {
        return;
      }

    }

    window.addEventListener("message", handleReplayMessage);
    return () => window.removeEventListener("message", handleReplayMessage);
  }, [
    activeView,
    loadState,
    markersVisible,
    onSelectIssue,
    replayConnectionState,
    replayIssues,
    rows,
    selectedIssueId,
    selectedVisibleIssueId
  ]);

  useEffect(() => {
    if (replayConnectionState !== "ready" || activeView !== "page") {
      return;
    }

    sendInitialIssues();
  }, [activeView, replayConnectionState, replayIssuesSignature, replayReadyEpoch]);

  useEffect(() => {
    if (replayConnectionState !== "ready" || activeView !== "page") {
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
  }, [activeView, replayConnectionState, selectedVisibleIssueId]);

  useEffect(() => {
    if (replayConnectionState !== "ready" || activeView !== "page") {
      return;
    }

    postToReplay({
      source: DASHBOARD_REPLAY_SOURCE,
      type: "SET_MARKERS_VISIBLE",
      markersVisible
    });
  }, [activeView, markersVisible, replayConnectionState]);

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

  function handleSeverityChange(nextFilter: typeof severityFilter) {
    setFallbackIssueId(null);
    setSeverityFilter(nextFilter);

    const nextVisibleRows =
      nextFilter === "ALL"
        ? rows
        : rows.filter((row) => row.severity.key === nextFilter);
    const currentSelectedIssueId = selectedIssueStateRef.current;

    if (
      currentSelectedIssueId !== null &&
      nextVisibleRows.some((row) => row.issue.id === currentSelectedIssueId)
    ) {
      return;
    }

    // Returning to ALL must not silently resurrect a selection the user already cleared.
    if (nextFilter === "ALL" && currentSelectedIssueId === null) {
      return;
    }

    const nextIssue =
      nextVisibleRows.find((row) => hasUsableIssueLocator(row.issue)) ??
      nextVisibleRows[0] ??
      null;
    const nextIssueId = nextIssue?.issue.id ?? null;

    if (nextIssueId !== currentSelectedIssueId) {
      // Close the window in which a replay message can race the parent state update.
      selectedIssueStateRef.current = nextIssueId;
      onSelectIssue(nextIssueId);
    }
  }

  function showPageView() {
    if (activeView !== "page") {
      setReplayConnectionState("loading");
      setActiveView("page");
    }
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

        <div className="site-page-evidence-toolbar" aria-label="페이지 검사 화면 도구">
          <div className="site-page-evidence-view-switch" aria-label="보기 방식">
            <button type="button" aria-pressed={activeView === "page"} onClick={showPageView}>
              <Eye aria-hidden="true" size={15} />
              페이지
            </button>
            <button
              type="button"
              aria-pressed={activeView === "code"}
              onClick={() => {
                setFallbackIssueId(null);
                setActiveView("code");
              }}
            >
              <Code2 aria-hidden="true" size={15} />
              코드
            </button>
          </div>

          {loadState === "ready" && activeView === "page" && (
            <>
              <label className="site-page-evidence-filter">
                <span>심각도</span>
                <select
                  value={severityFilter}
                  onChange={(event) => handleSeverityChange(event.target.value as typeof severityFilter)}
                >
                  <option value="ALL">전체</option>
                  <option value="CRITICAL">심각</option>
                  <option value="HIGH">높음</option>
                  <option value="MEDIUM">보통</option>
                  <option value="LOW">낮음</option>
                </select>
              </label>
              <button
                type="button"
                className="site-page-evidence-marker-toggle"
                aria-pressed={markersVisible}
                onClick={() =>
                  setMarkersVisible((current) => {
                    if (current) {
                      setFallbackIssueId(null);
                    }
                    return !current;
                  })
                }
              >
                {markersVisible ? <EyeOff aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={15} />}
                {markersVisible ? "마커 숨기기" : "마커 표시"}
              </button>

            </>
          )}
        </div>
      </header>

      <div className="site-page-evidence-body">
        {loadState === "loading" && (
          <div className="site-page-evidence-loading" role="status" aria-live="polite">
            <span className="site-page-evidence-loading-bar" />
            <span>페이지 재현 화면을 불러오는 중입니다</span>
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

        {loadState === "ready" && artifact && activeView === "page" && (
          <div className="site-page-evidence-grid">
            <div className="site-page-evidence-replay-column">
              <div
                className="site-page-evidence-preview"
                role="region"
                aria-label={`${targetName} 접근성 검사 페이지 재현 화면`}
                aria-busy={replayConnectionState === "loading"}
                data-connection-state={replayConnectionState}
              >
                <iframe
                  key={`${artifact.id}:${frameRevision}`}
                  ref={iframeRef}
                  className="site-page-evidence-replay-frame"
                  src={contentUrl ?? undefined}
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

              {replayConnectionState !== "ready" && (
                <div className="site-page-evidence-replay-feedback">
                  <p
                    className="site-page-evidence-connection"
                    data-state={replayConnectionState}
                    role="status"
                    aria-live="polite"
                  >
                    {replayConnectionState === "error" ? "재현 페이지 연결 끊김" : "재현 페이지 연결 중"}
                  </p>
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
                      {fallbackIssue.code ? `KWCAG ${fallbackIssue.code}` : "KWCAG"}
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

        {loadState === "ready" && artifact && activeView === "code" && (
          <div className="site-page-evidence-code-view">
            <div className="site-page-evidence-code-heading">
              <Code2 aria-hidden="true" size={17} />
              <h3>관련 코드</h3>
            </div>
            {selectedRow ? (
              <>
                <p>{selectedRow.issue.issueTitle}</p>
                <pre tabIndex={0} aria-label={`${selectedRow.issue.issueTitle} 관련 코드`}>
                  <code>
                    {selectedRow.issue.locator?.htmlSnippet ||
                      selectedRow.issue.locationPath ||
                      "이 스캔에는 관련 코드 조각이 저장되지 않았습니다."}
                  </code>
                </pre>
              </>
            ) : (
              <p className="site-page-evidence-code-empty">페이지 보기에서 이슈를 먼저 선택하세요.</p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
