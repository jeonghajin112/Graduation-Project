import { ChevronLeft, ChevronRight, LocateFixed } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";

import { formatIssueCodeLabel } from "./constants";
import { toPageReplayIssue } from "./page-replay-protocol";
import type { RecentIssueRow } from "./types";
import type { AnalyzerType } from "@/types/accessibility-domain";

const ANALYZER_LABELS: Record<AnalyzerType, string> = {
  RULE_BASED: "규칙 기반",
  AI_TEXT: "텍스트 난이도",
  CV_VISION: "시각 명암비"
};

type UnavailableLocatorPanelProps = {
  mode?: "recoverable" | "unavailable";
  onSelectIssue?: (issueId: number) => void;
  rows: RecentIssueRow[];
};

const UNAVAILABLE_ISSUE_PAGE_SIZE_QUERIES = [
  { pageSize: 5, query: "(min-width: 3200px) and (min-height: 2100px)" },
  { pageSize: 4, query: "(min-width: 3200px) and (min-height: 1850px)" },
  { pageSize: 3, query: "(min-width: 2560px) and (min-height: 1400px)" }
] as const;

function readUnavailableIssuePageSize() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return 1;
  }

  return (
    UNAVAILABLE_ISSUE_PAGE_SIZE_QUERIES.find(({ query }) => window.matchMedia(query).matches)
      ?.pageSize ?? 1
  );
}

function subscribeToUnavailableIssuePageSize(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const mediaQueries = UNAVAILABLE_ISSUE_PAGE_SIZE_QUERIES.map(({ query }) =>
    window.matchMedia(query)
  );
  mediaQueries.forEach((mediaQuery) => mediaQuery.addEventListener("change", onStoreChange));

  return () => {
    mediaQueries.forEach((mediaQuery) => mediaQuery.removeEventListener("change", onStoreChange));
  };
}

function useUnavailableIssuePageSize() {
  return useSyncExternalStore(
    subscribeToUnavailableIssuePageSize,
    readUnavailableIssuePageSize,
    () => 1
  );
}

export function UnavailableLocatorPanel({
  mode = "unavailable",
  onSelectIssue,
  rows
}: UnavailableLocatorPanelProps) {
  const [activeIssueId, setActiveIssueId] = useState<number | null>(null);
  const pageSize = useUnavailableIssuePageSize();
  const isRecoverable = mode === "recoverable";
  const headingId = `site-${mode}-locator-heading`;

  const selectedIndex = rows.findIndex((row) => row.issue.id === activeIssueId);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const pageStartIndex = Math.floor(activeIndex / pageSize) * pageSize;
  const visibleRows = rows.slice(pageStartIndex, pageStartIndex + pageSize);
  const pageEndIndex = pageStartIndex + visibleRows.length;

  useEffect(() => {
    const firstIssueId = rows[0]?.issue.id ?? null;
    if (activeIssueId !== null && rows.some((row) => row.issue.id === activeIssueId)) {
      return;
    }
    setActiveIssueId(firstIssueId);
  }, [activeIssueId, rows]);

  if (rows.length === 0) {
    return null;
  }

  return (
    <section
      className={`site-rail-card site-unavailable-locator-panel site-unavailable-locator-panel--${mode}`}
      data-locator-mode={mode}
      data-unavailable-locator-count={isRecoverable ? undefined : rows.length}
      data-hidden-state-locator-count={isRecoverable ? rows.length : undefined}
      data-unavailable-page-size={pageSize}
      data-visible-issue-count={visibleRows.length}
      aria-labelledby={headingId}
    >
      <div className="site-unavailable-locator-panel__header">
        <div className="site-rail-card__heading">
          <h3 id={headingId}>
            {isRecoverable ? "다른 화면 상태의 문제" : "화면에 표시되지 않은 문제"}
          </h3>
        </div>
        <span className="site-unavailable-locator-panel__count" aria-hidden="true">
          {rows.length.toLocaleString("ko-KR")}건
        </span>
      </div>

      <div
        className="site-unavailable-locator-panel__pagination"
        role="group"
        aria-label={isRecoverable ? "다른 화면 상태의 문제 탐색" : "화면에 표시되지 않은 문제 탐색"}
      >
        <button
          type="button"
          className="site-unavailable-locator-panel__navigation site-unavailable-locator-panel__navigation--previous"
          aria-label="이전 문제"
          onClick={() => setActiveIssueId(rows[Math.max(0, pageStartIndex - pageSize)]?.issue.id ?? null)}
          disabled={pageStartIndex === 0}
        >
          <ChevronLeft size={13} strokeWidth={2.25} aria-hidden="true" />
        </button>

        <ul className="site-unavailable-locator-panel__issues">
          {visibleRows.map((row, index) => {
            const replayIssue = toPageReplayIssue(row);
            const analyzerLabel = row.analyzerType ? ANALYZER_LABELS[row.analyzerType] : null;
            const ordinal = pageStartIndex + index + 1;
            const issueCode = formatIssueCodeLabel(replayIssue.code);
            const style = {
              "--site-unavailable-issue-color": row.severity.color
            } as CSSProperties;

            return (
              <li
                key={row.issue.id}
                className="site-unavailable-locator-panel__issue"
                data-issue-id={row.issue.id}
                style={style}
              >
                <div className="site-unavailable-locator-panel__meta">
                  <span className="site-unavailable-locator-panel__severity">
                    {row.severity.label}
                  </span>
                  {issueCode ? (
                    <span className="site-unavailable-locator-panel__code">{issueCode}</span>
                  ) : null}
                </div>
                <h4>{replayIssue.title}</h4>
                <p className="site-unavailable-locator-panel__message">{replayIssue.message}</p>
                {isRecoverable && onSelectIssue ? (
                  <button
                    type="button"
                    className="site-unavailable-locator-panel__reveal"
                    onClick={() => onSelectIssue(row.issue.id)}
                  >
                    <LocateFixed size={14} strokeWidth={2.2} aria-hidden="true" />
                    해당 장면에서 보기
                  </button>
                ) : null}
                <div className="site-unavailable-locator-panel__footer" aria-hidden="true">
                  {analyzerLabel ? (
                    <span className="site-unavailable-locator-panel__analyzer">{analyzerLabel}</span>
                  ) : <span />}
                  <span className="site-unavailable-locator-panel__ordinal">
                    {ordinal.toLocaleString("ko-KR")} / {rows.length.toLocaleString("ko-KR")}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          className="site-unavailable-locator-panel__navigation site-unavailable-locator-panel__navigation--next"
          aria-label="다음 문제"
          onClick={() => setActiveIssueId(rows[pageEndIndex]?.issue.id ?? null)}
          disabled={pageEndIndex >= rows.length}
        >
          <ChevronRight size={13} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>

      <span
        className="site-unavailable-locator-panel__position sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {visibleRows.length === 1
          ? `총 ${rows.length.toLocaleString("ko-KR")}건 중 ${pageStartIndex + 1}번째 문제: ${toPageReplayIssue(visibleRows[0]).title}`
          : `총 ${rows.length.toLocaleString("ko-KR")}건 중 ${pageStartIndex + 1}번째부터 ${pageEndIndex}번째 문제`}
      </span>
    </section>
  );
}
