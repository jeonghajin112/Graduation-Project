import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { SeverityLevel } from "@/types/accessibility-domain";

import { groupByCriterion, type ReportCriterionGroup } from "./final-report";
import { buildSharedGuidance, describeIssueLine, readIssue, type IssueReading } from "./issue-guidance";
import { getLocatorLabel } from "./locator-labels";
import type { LocatorCheckState, LocatorIssueState, RecentIssueRow } from "./types";

type UnavailableLocatorPanelProps = {
  checkState: LocatorCheckState;
  hasHiddenIssues?: boolean;
  mode?: "page-settings" | "unavailable";
  /** Findings shown once the page switches state (a slide, tab or focus); they join the hidden list. */
  recoverableRows?: RecentIssueRow[];
  onSelectIssue?: (issueId: number) => void;
  onShowLocation: (issueId: number) => void;
  issueStates?: Record<number, LocatorIssueState>;
  rows: RecentIssueRow[];
};

const panelHeadings = {
  "page-settings": "페이지 전체 설정",
  unavailable: "화면에 표시되지 않은 문제"
};

const STATE_FILTER = "다른 화면 상태";
const ALL_FILTER = "전체";
const INITIAL_VISIBLE = 4;
const MORE_STEP = 6;
const OPEN_MS = 280;
const FOLD_MS = 240;
const SLIDE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Slides a group body between two measured heights. The body clips only
 * while it moves, so focus rings are never cut once it rests. A fold holds
 * its last frame until the rows are removed, so the full height never
 * flashes back between the end of the fold and the removal.
 */
function slide(body: HTMLElement, from: number, to: number): Animation {
  const folding = to === 0;
  body.style.overflow = "clip";
  const animation = body.animate(
    [{ height: `${from}px`, opacity: from === 0 ? 0 : 1 }, { height: `${to}px`, opacity: folding ? 0 : 1 }],
    { duration: folding ? FOLD_MS : OPEN_MS, easing: SLIDE_EASING, fill: folding ? "forwards" : "none" }
  );
  if (!folding) animation.finished.then(() => { body.style.overflow = ""; }, () => {});
  return animation;
}
const severityRank: Record<SeverityLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

type Entry = { row: RecentIssueRow; recoverable: boolean; reason: string };

function filterKey(entry: Entry): string {
  return entry.recoverable ? STATE_FILTER : entry.reason;
}

/**
 * The rail's list of findings without a place on the current screen, grouped
 * by criterion like the final report: each group says its shared advice once
 * and lists one short line per finding. Chips filter by why a finding is not
 * on screen; findings in another screen state are one of those reasons.
 */
// One shared empty list, so a panel without recoverable findings keeps its
// memoized entries between renders.
const NO_ROWS: RecentIssueRow[] = [];

export function UnavailableLocatorPanel({
  checkState,
  hasHiddenIssues = false,
  mode = "unavailable",
  recoverableRows = NO_ROWS,
  onSelectIssue,
  onShowLocation,
  issueStates,
  rows
}: UnavailableLocatorPanelProps) {
  const [filter, setFilter] = useState(ALL_FILTER);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [visibleCounts, setVisibleCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const heading = panelHeadings[mode];
  const headingId = `site-${mode}-locator-heading`;

  const entries = useMemo<Entry[]>(() => [
    ...recoverableRows.map((row) => ({ row, recoverable: true, reason: getLocatorLabel(issueStates?.[row.issue.id]) })),
    ...rows.map((row) => ({ row, recoverable: false, reason: getLocatorLabel(issueStates?.[row.issue.id]) }))
  ], [recoverableRows, rows, issueStates]);

  // Only the hidden list filters; most common reason first.
  const filters = useMemo(() => {
    if (mode !== "unavailable") return [];
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(filterKey(entry), (counts.get(filterKey(entry)) ?? 0) + 1);
    const ordered = [...counts.entries()].sort(([leftKey, left], [rightKey, right]) =>
      Number(rightKey === STATE_FILTER) - Number(leftKey === STATE_FILTER) || right - left);
    return ordered.length > 1 ? [[ALL_FILTER, entries.length] as const, ...ordered] : [];
  }, [entries, mode]);
  const activeFilter = filters.some(([key]) => key === filter) ? filter : ALL_FILTER;
  const shown = useMemo(
    () => activeFilter === ALL_FILTER ? entries : entries.filter((entry) => filterKey(entry) === activeFilter),
    [activeFilter, entries]
  );

  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.row.issue.id, entry])), [entries]);
  const groups = useMemo(() => groupByCriterion(shown.map((entry) => entry.row))
    .sort((left, right) => severityRank[left.severity.key] - severityRank[right.severity.key] || right.rows.length - left.rows.length),
  [shown]);
  if (checkState !== "ready" || entries.length === 0) {
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
      data-hidden-state-locator-count={recoverableRows.length > 0 ? recoverableRows.length : undefined}
      data-locator-count={entries.length}
      aria-labelledby={headingId}
    >
      <div className="site-unavailable-locator-panel__header">
        <div className="site-rail-card__heading">
          <h3 id={headingId}>{heading}</h3>
        </div>
        <span className="site-unavailable-locator-panel__count" aria-hidden="true">
          {shown.length.toLocaleString("ko-KR")}건
        </span>
      </div>
      {filters.length > 0 && (
        <div className="site-unavailable-locator-panel__reasons" role="group" aria-label="이유로 거르기">
          {filters.map(([key, count]) => (
            <button key={key} type="button" className="site-unavailable-locator-panel__filter"
              aria-pressed={activeFilter === key} onClick={() => setFilter(key)}>
              {key} <span>{count.toLocaleString("ko-KR")}</span>
            </button>
          ))}
        </div>
      )}

      <div className="site-unavailable-locator-panel__groups">
        {/* Every group starts folded; only the user opens one. */}
        {groups.map((group) => {
          const expanded = toggled.get(group.code) ?? false;
          return (
            <LocatorGroup
              key={group.code}
              group={group}
              expanded={expanded}
              visibleCount={visibleCounts.get(group.code) ?? INITIAL_VISIBLE}
              entryById={entryById}
              mode={mode}
              onToggle={() => setToggled((current) => new Map(current).set(group.code, !expanded))}
              onShowMore={() => setVisibleCounts((current) =>
                new Map(current).set(group.code, (current.get(group.code) ?? INITIAL_VISIBLE) + MORE_STEP))}
              onSelectIssue={onSelectIssue}
              onShowLocation={onShowLocation}
            />
          );
        })}
      </div>
    </section>
  );
}

function LocatorGroup({ group, expanded, visibleCount, entryById, mode, onToggle, onShowMore, onSelectIssue, onShowLocation }: {
  group: ReportCriterionGroup;
  expanded: boolean;
  visibleCount: number;
  entryById: ReadonlyMap<number, Entry>;
  mode: "page-settings" | "unavailable";
  onToggle: () => void;
  onShowMore: () => void;
  onSelectIssue?: (issueId: number) => void;
  onShowLocation: (issueId: number) => void;
}) {
  const listId = `site-${mode}-locator-${group.code.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const readings = useMemo(() => new Map<number, IssueReading>(group.rows.map((row) => [row.issue.id, readIssue(row)])), [group.rows]);
  const shared = useMemo(
    () => buildSharedGuidance(group.rows, (row) => readings.get(row.issue.id) ?? readIssue(row)),
    [group.rows, readings]
  );
  const visibleRows = group.rows.slice(0, visibleCount);
  const remaining = group.rows.length - visibleRows.length;
  // Opening slides the rows down from the header; closing folds them back
  // up from their current height and removes them the moment they are gone.
  // Only a press animates; a group opened by a live update simply appears.
  const [mounted, setMounted] = useState(expanded);
  const pressedRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  if (expanded && !mounted) setMounted(true);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const pressed = pressedRef.current;
    pressedRef.current = false;
    if (!body) return;
    body.inert = !expanded;
    const animate = pressed && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const moving = body.getAnimations();
    const current = body.getBoundingClientRect().height;
    moving.forEach((animation) => animation.cancel());
    body.style.overflow = "";
    if (expanded) {
      if (animate) slide(body, moving.length > 0 ? current : 0, body.getBoundingClientRect().height);
      return;
    }
    if (animate) {
      slide(body, current, 0).finished.then(() => setMounted(false), () => {});
    } else {
      void Promise.resolve().then(() => setMounted(false));
    }
  }, [expanded]);

  return (
    <section className="site-unavailable-locator-panel__group">
      <h4>
        <button type="button" className="site-unavailable-locator-panel__group-toggle" aria-expanded={expanded}
          aria-controls={listId} onClick={() => {
            pressedRef.current = true;
            onToggle();
          }}>
          {group.codeLabel && <span className="site-unavailable-locator-panel__code">{group.codeLabel}</span>}
          <span className="site-unavailable-locator-panel__group-name">{group.title}</span>
          <span className="site-unavailable-locator-panel__group-count">{group.rows.length.toLocaleString("ko-KR")}건</span>
          <span className="site-unavailable-locator-panel__plus" aria-hidden="true">{expanded ? "−" : "+"}</span>
        </button>
      </h4>
      <div ref={bodyRef} id={listId} hidden={!mounted} data-state={expanded ? "open" : "closing"}
        className="site-unavailable-locator-panel__group-body">
        {mounted && (
          <div className="site-unavailable-locator-panel__group-inner">
            {/* The rail stays short: the header names the criterion, and the
                advice each finding shares is read in its details dialog. */}
            <ul className="site-unavailable-locator-panel__issues">
              {visibleRows.map((row) => {
                const entry = entryById.get(row.issue.id);
                const recoverable = Boolean(entry?.recoverable && onSelectIssue);
                const carousel = row.issue.locator?.carouselContext;
                const line = describeIssueLine(row, readings.get(row.issue.id) ?? readIssue(row), shared);
                return (
                  <li key={row.issue.id} className="site-unavailable-locator-panel__issue" data-issue-id={row.issue.id}
                    style={{ "--site-unavailable-issue-color": row.severity.color } as CSSProperties}>
                    <button type="button" className="site-unavailable-locator-panel__line"
                      onClick={() => recoverable ? onSelectIssue?.(row.issue.id) : onShowLocation(row.issue.id)}>
                      <span className="site-unavailable-locator-panel__severity">{row.severity.label}</span>
                      <span className="site-unavailable-locator-panel__line-main">
                        <span className="site-unavailable-locator-panel__line-title" data-copyable>{line.title}</span>
                        <span className="site-unavailable-locator-panel__line-reason">
                          <span className="site-unavailable-locator-panel__reason">{entry?.reason}</span>
                          {carousel ? ` · ${carousel.slideCount}장 중 ${carousel.slideIndex + 1}번째` : null}
                        </span>
                      </span>
                      <span className={`site-unavailable-locator-panel__action${recoverable ? " site-unavailable-locator-panel__action--primary" : ""}`}>
                        {recoverable ? "위치로 이동" : "상세"}<span aria-hidden="true"> ›</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {remaining > 0 && (
              <button type="button" className="site-unavailable-locator-panel__more" onClick={onShowMore}>
                더 보기 · 남은 {remaining.toLocaleString("ko-KR")}건
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
