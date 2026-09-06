import { ChevronLeft, ChevronRight, LocateFixed } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { formatIssueCodeLabel } from "./constants";
import { getLocatorExplanation } from "./locator-explanation";
import { toPageReplayIssue } from "./page-replay-protocol";
import type { LocatorCheckState, LocatorIssueState, RecentIssueRow } from "./types";

type UnavailableLocatorPanelProps = {
  checkState: LocatorCheckState;
  hasHiddenIssues?: boolean;
  mode?: "recoverable" | "unavailable";
  onSelectIssue?: (issueId: number) => void;
  onShowLocation: (issueId: number) => void;
  issueStates?: Record<number, LocatorIssueState>;
  rows: RecentIssueRow[];
};

// 최대 세 페이지를 표시하며 첫 페이지는 왼쪽, 마지막 페이지는 오른쪽에 둔다.
function getPagerDotWindow(pageCount: number, pageIndex: number) {
  const dotCount = Math.min(3, pageCount);
  const startIndex = Math.max(0, Math.min(pageIndex - 1, pageCount - dotCount));
  return Array.from({ length: dotCount }, (_, offset) => startIndex + offset);
}

function useUnavailableIssuePageSize(hasVisibleRows: boolean) {
  const listRef = useRef<HTMLUListElement>(null);
  const [pageSize, setPageSize] = useState(1);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!hasVisibleRows || !list) return;

    const measure = () => {
      const style = getComputedStyle(list);
      // CSS reserves one readable card and keeps list content from expanding
      // the rail. Measure that stable space, including gaps between cards.
      const minimumCardHeight = Number.parseFloat(style.minHeight);
      const gap = Number.parseFloat(style.rowGap) || 0;
      if (!Number.isFinite(minimumCardHeight) || minimumCardHeight <= 0) return;
      const capacity = Math.max(1, Math.floor((list.clientHeight + gap) / (minimumCardHeight + gap)));
      setPageSize(previous => previous === capacity ? previous : capacity);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [hasVisibleRows]);

  return { listRef, pageSize };
}

export function UnavailableLocatorPanel({
  checkState,
  hasHiddenIssues = false,
  mode = "unavailable",
  onSelectIssue,
  onShowLocation,
  issueStates,
  rows
}: UnavailableLocatorPanelProps) {
  const [activeIssueId, setActiveIssueId] = useState<number | null>(null);
  const { listRef, pageSize } = useUnavailableIssuePageSize(checkState === "ready" && rows.length > 0);
  const isRecoverable = mode === "recoverable";
  const headingId = `site-${mode}-locator-heading`;

  const selectedIndex = rows.findIndex((row) => row.issue.id === activeIssueId);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const pageStartIndex = Math.floor(activeIndex / pageSize) * pageSize;
  const visibleRows = rows.slice(pageStartIndex, pageStartIndex + pageSize);
  const pageEndIndex = pageStartIndex + visibleRows.length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageIndex = Math.floor(pageStartIndex / pageSize);
  // Reset only the visual dots when the list changes; keep the buttons and keyboard focus.
  const dotLayoutKey = `${pageSize}:${rows.map((row) => row.issue.id).join(",")}`;
  const goToPage = (nextPageIndex: number) => {
    const clamped = Math.min(pageCount - 1, Math.max(0, nextPageIndex));
    setActiveIssueId(rows[clamped * pageSize]?.issue.id ?? null);
  };

  useEffect(() => {
    const firstIssueId = rows[0]?.issue.id ?? null;
    if (activeIssueId !== null && rows.some((row) => row.issue.id === activeIssueId)) {
      return;
    }
    setActiveIssueId(firstIssueId);
  }, [activeIssueId, rows]);

  if (checkState !== "ready" || rows.length === 0) {
    if (isRecoverable) {
      return null;
    }
    return (
      <section
        className="site-rail-card site-unavailable-locator-panel site-unavailable-locator-panel--unavailable is-empty"
        data-locator-mode="unavailable"
        data-locator-check-state={checkState}
        data-unavailable-locator-count={checkState === "ready" ? 0 : undefined}
        data-unavailable-page-size={pageSize}
        data-visible-issue-count={0}
        aria-labelledby={headingId}
        aria-busy={checkState === "loading"}
      >
        <div className="site-unavailable-locator-panel__header">
          <div className="site-rail-card__heading">
            <h3 id={headingId}>화면에 표시되지 않은 문제</h3>
          </div>
          {checkState === "ready" && (
            <span className="site-unavailable-locator-panel__count" aria-hidden="true">0건</span>
          )}
        </div>
        <p className="site-unavailable-locator-panel__empty" role="status">
          {checkState === "loading"
            ? "문제 위치를 확인하고 있습니다."
            : checkState === "error"
              ? "검사 화면에 연결하지 못해 문제 위치를 확인할 수 없습니다."
              : hasHiddenIssues
                ? "다른 화면 상태의 문제는 위 목록에서 확인할 수 있습니다."
                : "모든 문제가 화면에 표시되고 있습니다."}
        </p>
      </section>
    );
  }

  return (
    <section
      className={`site-rail-card site-unavailable-locator-panel site-unavailable-locator-panel--${mode}`}
      data-locator-mode={mode}
      data-locator-check-state={checkState}
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
        <ul ref={listRef} className="site-unavailable-locator-panel__issues">
          {visibleRows.map((row) => {
            const replayIssue = toPageReplayIssue(row);
            const issueCode = formatIssueCodeLabel(replayIssue.code);
            const style = {
              "--site-unavailable-issue-color": row.severity.color
            } as CSSProperties;

            return (
              <li
                key={row.issue.id}
                className="site-unavailable-locator-panel__issue"
                data-issue-id={row.issue.id}
                data-pageable={pageCount > 1 ? "true" : "false"}
                style={style}
                onClick={(event) => {
                  if (pageCount <= 1 || (event.target as HTMLElement).closest("button")) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  if (event.clientX - bounds.left < bounds.width / 2) goToPage(pageIndex - 1);
                  else goToPage(pageIndex + 1);
                }}
              >
                <div className="site-unavailable-locator-panel__issue-header">
                  <div className="site-unavailable-locator-panel__meta">
                    <span className="site-unavailable-locator-panel__severity">
                      {row.severity.label}
                    </span>
                    {issueCode ? (
                      <span className="site-unavailable-locator-panel__code">{issueCode}</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="site-unavailable-locator-panel__reveal site-unavailable-locator-panel__location"
                    onClick={() => onShowLocation(row.issue.id)}
                  >
                    위치 정보
                  </button>
                </div>
                <h4>{replayIssue.title}</h4>
                <p className="site-unavailable-locator-panel__reason">
                  {getLocatorExplanation(issueStates?.[row.issue.id]).label}
                </p>
                <p className="site-unavailable-locator-panel__message">{replayIssue.message}</p>
                {isRecoverable && onSelectIssue ? (
                  <div className="site-unavailable-locator-panel__actions">
                    <button
                      type="button"
                      className="site-unavailable-locator-panel__reveal"
                      onClick={() => onSelectIssue(row.issue.id)}
                    >
                      <LocateFixed size={14} strokeWidth={2.2} aria-hidden="true" />
                      해당 장면에서 보기
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div
          className="site-unavailable-locator-panel__pager"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); goToPage(pageIndex - 1); }
            if (event.key === "ArrowRight") { event.preventDefault(); goToPage(pageIndex + 1); }
          }}
        >
          <button
            type="button"
            className="site-unavailable-locator-panel__navigation site-unavailable-locator-panel__navigation--previous sr-only"
            aria-label="이전 문제"
            onClick={() => goToPage(pageIndex - 1)}
            disabled={pageStartIndex === 0}
          >
            <ChevronLeft size={13} strokeWidth={2.25} aria-hidden="true" />
          </button>
          {pageCount > 1 ? (
            <span className="site-unavailable-locator-panel__dots">
              {getPagerDotWindow(pageCount, pageIndex).map((index) => (
                <button
                  key={index}
                  type="button"
                  className="site-unavailable-locator-panel__dot"
                  data-active={index === pageIndex ? "true" : "false"}
                  aria-label={`${index + 1}번째 페이지`}
                  aria-current={index === pageIndex ? "true" : undefined}
                  onClick={() => goToPage(index)}
                >
                  <span
                    key={dotLayoutKey}
                    className="site-unavailable-locator-panel__dot-shape"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </span>
          ) : null}
          <button
            type="button"
            className="site-unavailable-locator-panel__navigation site-unavailable-locator-panel__navigation--next sr-only"
            aria-label="다음 문제"
            onClick={() => goToPage(pageIndex + 1)}
            disabled={pageEndIndex >= rows.length}
          >
            <ChevronRight size={13} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>
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
