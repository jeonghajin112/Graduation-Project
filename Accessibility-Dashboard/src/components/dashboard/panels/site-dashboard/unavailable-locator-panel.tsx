import { ChevronLeft, ChevronRight, LocateFixed } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { formatIssueCodeLabel } from "./constants";
import { getIssueCoordinateBox } from "./issue-locator";
import { getLocatorLabel } from "./locator-labels";
import { toPageReplayIssue } from "./page-replay-protocol";
import type { LocatorCheckState, LocatorIssueState, RecentIssueRow } from "./types";

type UnavailableLocatorPanelProps = {
  checkState: LocatorCheckState;
  hasHiddenIssues?: boolean;
  mode?: "recoverable" | "page-settings" | "unavailable";
  onSelectIssue?: (issueId: number) => void;
  onShowLocation: (issueId: number) => void;
  issueStates?: Record<number, LocatorIssueState>;
  rows: RecentIssueRow[];
  /** Capture pixel scale for screenshot coordinates. */
  deviceScaleFactor?: number | null;
};

const panelHeadings = {
  recoverable: "다른 화면 상태의 문제",
  "page-settings": "페이지 전체 설정",
  unavailable: "화면에 표시되지 않은 문제"
};

const pathContextLabels: Record<string, string> = { FRAME: "프레임 안", SHADOW_ROOT: "Shadow DOM 안" };

// The rail names where a finding is in one line: the element the path ends
// at (and whether it is inside a frame or shadow root). The details dialog
// and the final report keep the full path, HTML and explanation.
function describeWhere(
  row: RecentIssueRow,
  analyzedText?: string,
  deviceScaleFactor?: number | null
): { text: string; full: string; code: boolean } {
  const { locator, locationPath } = row.issue;
  const steps = (Array.isArray(locator?.pathSteps) ? locator.pathSteps : [])
    .filter((step) => typeof step?.selector === "string" && step.selector.trim().length > 0);
  if (steps.length > 0) {
    const last = steps[steps.length - 1]!;
    const context = pathContextLabels[String(last.context)];
    const selector = last.selector.trim();
    return {
      text: context ? `${context} · ${selector}` : selector,
      full: steps.map((step) => step.selector.trim()).join(" › "),
      code: true
    };
  }
  // Screenshot pixels read in document CSS pixels, like the page markers.
  const box = getIssueCoordinateBox(row.issue, deviceScaleFactor);
  const point = box ?? (typeof locator?.x === "number" && typeof locator.y === "number"
    ? { x: locator.x, y: locator.y }
    : null);
  if (point) {
    const text = `화면 좌표 x ${Math.round(point.x)}, y ${Math.round(point.y)}`;
    return { text, full: text, code: false };
  }
  const path = locationPath.trim();
  if (path) return { text: path, full: path, code: true };
  // Without a path, the analysed sentence is what a developer can search for.
  const sentence = analyzedText?.replace(/\s+/g, " ").trim();
  if (sentence) return { text: `문장 “${sentence}”`, full: sentence, code: false };
  return { text: "위치 정보 없음", full: "위치 정보 없음", code: false };
}

// How many findings share each reason, most common first.
function summarizeReasons(rows: RecentIssueRow[], issueStates?: Record<number, LocatorIssueState>) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = getLocatorLabel(issueStates?.[row.issue.id]);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

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
    const panel = list.closest<HTMLElement>(".site-unavailable-locator-panel");
    const rail = panel?.parentElement;
    if (!panel || !rail) return;
    const header = panel.querySelector<HTMLElement>(".site-unavailable-locator-panel__header");
    const pagination = list.parentElement;
    const pager = panel.querySelector<HTMLElement>(".site-unavailable-locator-panel__pager");
    if (!header || !pagination || !pager) return;
    // The reason summary sits outside the pages.
    const extrasOf = () => [...panel.querySelectorAll<HTMLElement>(".site-unavailable-locator-panel__reasons")];

    const measure = () => {
      const style = getComputedStyle(list);
      const minimumCardHeight = Number.parseFloat(style.minHeight);
      const gap = Number.parseFloat(style.rowGap) || 0;
      if (!Number.isFinite(minimumCardHeight) || minimumCardHeight <= 0) return;
      const panelStyle = getComputedStyle(panel);
      const paginationStyle = getComputedStyle(pagination);
      const px = (value: string) => Number.parseFloat(value) || 0;
      // Measure the chrome independently of the constrained panel height.
      // Subtracting list height from panel height retains the old max-height
      // after zoom/resize increases padding, trapping the pager at the edge.
      const chromeHeight = px(panelStyle.paddingTop) + px(panelStyle.paddingBottom)
        + px(panelStyle.borderTopWidth) + px(panelStyle.borderBottomWidth)
        + header.getBoundingClientRect().height
        + px(paginationStyle.marginTop) + px(paginationStyle.marginBottom)
        + px(paginationStyle.rowGap) + pager.getBoundingClientRect().height
        + extrasOf().reduce((sum, element) => {
          const style = getComputedStyle(element);
          return sum + element.getBoundingClientRect().height + px(style.marginTop) + px(style.marginBottom);
        }, 0);
      const chromeValue = `${chromeHeight}px`;
      if (panel.style.getPropertyValue("--site-unavailable-panel-chrome-height") !== chromeValue) {
        panel.style.setProperty("--site-unavailable-panel-chrome-height", chromeValue);
      }
      const panelBounds = panel.getBoundingClientRect();
      // A compact panel leaves unused rail space below it. Include that space
      // when measuring capacity so shrinking the panel does not shrink its pages.
      const remainingRailHeight = panel === rail.lastElementChild && getComputedStyle(rail).alignSelf === "stretch"
        ? Math.max(0, rail.getBoundingClientRect().bottom - panelBounds.bottom)
        : 0;
      // Allow subpixel layout rounding without losing an otherwise fitting row.
      const capacity = Math.max(1, Math.floor((panelBounds.height + remainingRailHeight - chromeHeight + gap + 0.5) / (minimumCardHeight + gap)));
      setPageSize(previous => previous === capacity ? previous : capacity);
    };

    const observer = new ResizeObserver(measure);
    const observeRail = () => {
      observer.disconnect();
      observer.observe(list);
      observer.observe(rail);
      observer.observe(header);
      observer.observe(pager);
      for (const element of extrasOf()) observer.observe(element);
      for (const card of rail.children) observer.observe(card);
      measure();
    };
    observeRail();
    const childObserver = new MutationObserver(observeRail);
    childObserver.observe(rail, { childList: true });
    childObserver.observe(panel, { childList: true });
    return () => {
      observer.disconnect();
      childObserver.disconnect();
    };
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
  rows,
  deviceScaleFactor = null
}: UnavailableLocatorPanelProps) {
  const [activeIssueId, setActiveIssueId] = useState<number | null>(null);
  const { listRef, pageSize } = useUnavailableIssuePageSize(checkState === "ready" && rows.length > 0);
  const isRecoverable = mode === "recoverable";
  const heading = panelHeadings[mode];
  const headingId = `site-${mode}-locator-heading`;
  const reasonCounts = mode === "unavailable" ? summarizeReasons(rows, issueStates) : [];

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
    // Only the last list explains an empty or pending state.
    if (mode !== "unavailable") {
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
                ? "그 밖의 문제는 위 목록에서 확인할 수 있습니다."
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
      data-unavailable-locator-count={mode === "unavailable" ? rows.length : undefined}
      data-hidden-state-locator-count={isRecoverable ? rows.length : undefined}
      data-locator-count={rows.length}
      data-unavailable-page-size={pageSize}
      data-visible-issue-count={visibleRows.length}
      style={{ "--site-unavailable-visible-count": visibleRows.length } as CSSProperties}
      aria-labelledby={headingId}
    >
      <div className="site-unavailable-locator-panel__header">
        <div className="site-rail-card__heading">
          <h3 id={headingId}>{heading}</h3>
        </div>
        <span className="site-unavailable-locator-panel__count" aria-hidden="true">
          {rows.length.toLocaleString("ko-KR")}건
        </span>
      </div>
      {reasonCounts.length > 1 ? (
        <ul className="site-unavailable-locator-panel__reasons" aria-label="이유별 건수">
          {reasonCounts.slice(0, 3).map(([label, count]) => (
            <li key={label}>{label} <strong>{count.toLocaleString("ko-KR")}</strong></li>
          ))}
          {reasonCounts.length > 3 ? <li>그 밖의 이유 {reasonCounts.slice(3).reduce((sum, [, count]) => sum + count, 0)}</li> : null}
        </ul>
      ) : null}

      <div
        className="site-unavailable-locator-panel__pagination"
        role="group"
        aria-label={`${heading} 탐색`}
      >
        <ul ref={listRef} className="site-unavailable-locator-panel__issues">
          {visibleRows.map((row) => {
            const replayIssue = toPageReplayIssue(row);
            const issueCode = formatIssueCodeLabel(replayIssue.code);
            const where = describeWhere(row, replayIssue.textAnalysis?.sourceText, deviceScaleFactor);
            const style = {
              "--site-unavailable-issue-color": row.severity.color
            } as CSSProperties;

            return (
              <li
                key={row.issue.id}
                className="site-unavailable-locator-panel__issue"
                data-issue-id={row.issue.id}
                data-pageable={pageCount > 1 ? "true" : "false"}
                tabIndex={0}
                aria-label={`${replayIssue.title} 설명`}
                style={style}
                onClick={(event) => {
                  if (pageCount <= 1 || (event.target as HTMLElement).closest("button")) return;
                  const selection = window.getSelection();
                  if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  // Using the card's scrollbar must not turn the issue page.
                  const localX = (event.clientX - bounds.left) * event.currentTarget.offsetWidth / bounds.width;
                  if (localX >= event.currentTarget.clientLeft + event.currentTarget.clientWidth) return;
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
                    문제 상세
                  </button>
                </div>
                <h4 data-copyable>{replayIssue.title}</h4>
                <dl className="site-unavailable-locator-panel__facts">
                  <div>
                    <dt>이유</dt>
                    <dd data-copyable className="site-unavailable-locator-panel__reason">
                      {getLocatorLabel(issueStates?.[row.issue.id])}
                    </dd>
                  </div>
                  <div>
                    <dt>위치</dt>
                    <dd data-copyable className="site-unavailable-locator-panel__where" title={where.full}>
                      {where.code ? <code>{where.text}</code> : where.text}
                    </dd>
                  </div>
                </dl>
                {isRecoverable && onSelectIssue ? (
                  <div className="site-unavailable-locator-panel__actions">
                    <button
                      type="button"
                      className="site-unavailable-locator-panel__reveal"
                      onClick={() => onSelectIssue(row.issue.id)}
                    >
                      <LocateFixed size={14} strokeWidth={2.2} aria-hidden="true" />
                      문제 위치로 이동
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
            className="site-unavailable-locator-panel__navigation site-unavailable-locator-panel__navigation--previous"
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
            className="site-unavailable-locator-panel__navigation site-unavailable-locator-panel__navigation--next"
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
