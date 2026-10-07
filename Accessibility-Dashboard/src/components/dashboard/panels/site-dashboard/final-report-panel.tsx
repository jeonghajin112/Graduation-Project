import {
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  CircleCheck,
  CircleHelp,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";

import type {
  AnalyzerType,
  EvaluationRequestModel,
  EvaluationResultSummary,
  EvaluationTargetModel,
  ScoreResult
} from "@/types/accessibility-domain";

import { formatDateTime } from "../../shared/utils";
import {
  analyzerLabels,
  canShowOnPage,
  defaultReportFilters,
  describeIssueLocation,
  filterReportRows,
  getEffectiveReportFilters,
  getReportLocationStatus,
  groupByCriterion,
  summarizeReport,
  type ReportCriterionGroup,
  type ReportFilters,
  type ReportLocationStatus
} from "./final-report";
import { buildSharedGuidance, describeIssueLine, partLabel, readIssue, type IssueReading, type SharedGuidance } from "./issue-guidance";
import { buildCriteriaOverview, describeCriterion } from "./kwcag-criteria";
import { ReportCriteriaOverview } from "./report-criteria-overview";
import { ReportScoreTrend } from "./report-score-trend";
import { buildScoreTrend, compareWithPrevious } from "./score-trend";
import type { LocatorCheckState, LocatorIssueState, RecentIssueRow, SeverityChartItem } from "./types";
import type { EvaluationResultDetailsLoadState } from "./use-evaluation-result-details";

import "@/styles/final-report.css";

const ISSUE_PAGE_SIZE = 20;
const HTML_PREVIEW_LIMIT = 600;

type FinalReportPanelProps = {
  active: boolean;
  target: EvaluationTargetModel;
  analyzedAt: string | null;
  requestId: number | null;
  /** The target's requests, for the score history in the summary. */
  evaluationRequests: EvaluationRequestModel[];
  scoreResults: ScoreResult[];
  resultSummaries: EvaluationResultSummary[];
  rows: RecentIssueRow[];
  loadState: EvaluationResultDetailsLoadState;
  errorMessage: string | null;
  onRetry: () => void;
  locatorCheckState: LocatorCheckState;
  issueStates?: Record<number, LocatorIssueState>;
  onShowOnPage: (issueId: number) => void;
  /** Capture pixel scale, so screenshot coordinates read like the page markers. */
  deviceScaleFactor?: number | null;
  /** The same re-analysis request the results view offers; absent when it cannot run. */
  onRequestAnalysis?: () => void;
  isRequestingAnalysis?: boolean;
  analysisRequestError?: string | null;
};

function formatCount(count: number): string {
  return `${count.toLocaleString("ko-KR")}건`;
}

function formatScore(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
}

/** Positive means better for the reader: a higher score or fewer issues. */
function direction(better: number): "better" | "worse" | "same" {
  return better > 0 ? "better" : better < 0 ? "worse" : "same";
}

type EngineState = "done" | "failed" | "not-measured" | "unknown";
type EngineOutcome = { state: Exclude<EngineState, "done">; label: string };

const engineOutcomeLabels: Record<EngineOutcome["state"], string> = {
  failed: "검사 실패",
  "not-measured": "측정 안 됨",
  unknown: "확인 안 됨"
};

function engineState(status: string | null | undefined): EngineState {
  if (status === "SUCCESS") return "done";
  if (status === "FAILED") return "failed";
  if (status === "NOT_MEASURED") return "not-measured";
  return "unknown";
}

function describeEngineScope(outcomes: Array<EngineOutcome | null>): string {
  const unfinished = outcomes.filter((outcome) => outcome && outcome.state !== "unknown").length;
  const unknown = outcomes.filter((outcome) => outcome?.state === "unknown").length;
  if (unfinished && unknown) return `${unfinished}개 검사를 마치지 못했고, ${unknown}개는 결과가 기록되지 않았습니다`;
  if (unfinished) return `${unfinished}개 검사를 마치지 못했습니다`;
  if (unknown) return `${unknown}개 검사는 결과가 기록되지 않았습니다`;
  return "모든 검사를 마쳤습니다";
}

function severityStyle(color: string): CSSProperties {
  return { "--site-report-severity-color": color } as CSSProperties;
}

function contextLabel(context: string): string {
  return context === "FRAME" ? "프레임 내부" : context === "SHADOW_ROOT" ? "Shadow DOM 내부" : "문서";
}

export function FinalReportPanel({
  active,
  target,
  analyzedAt,
  requestId,
  evaluationRequests,
  scoreResults,
  resultSummaries,
  rows,
  loadState,
  errorMessage,
  onRetry,
  locatorCheckState,
  issueStates,
  onShowOnPage,
  deviceScaleFactor = null,
  onRequestAnalysis,
  isRequestingAnalysis = false,
  analysisRequestError = null
}: FinalReportPanelProps) {
  const [filters, setFilters] = useState<ReportFilters>(defaultReportFilters);
  const [expandedCodes, setExpandedCodes] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleCounts, setVisibleCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [isPrinting, setIsPrinting] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ code: string } | null>(null);
  const reportRef = useRef<HTMLElement>(null);
  // A measured zero is a real score; only a missing result is unknown.
  const scoreResult = requestId === null ? undefined : scoreResults.find((result) => result.evaluationRequestId === requestId);
  const score = scoreResult?.totalScore ??
    resultSummaries.find((summary) => summary.requestId === requestId)?.totalScore ?? null;
  const cvStatus = scoreResult?.cvStatus ?? null;
  // Only a recorded SUCCESS counts as done. Older analyses stored no outcome
  // (null), which is neither a pass nor a failure: it is shown as unknown.
  const textState = engineState(scoreResult?.textStatus);
  const cvState = engineState(cvStatus);
  const textFailed = textState === "failed";
  const cvIncomplete = cvState === "failed" || cvState === "not-measured";
  const unknownEngines: AnalyzerType[] = [
    ...(textState === "unknown" ? ["AI_TEXT" as const] : []),
    ...(cvState === "unknown" ? ["CV_VISION" as const] : [])
  ];
  // An engine that did not run reports no issues; show that instead of "0건".
  const engineOutcome = (analyzer: AnalyzerType): EngineOutcome | null => {
    const state = analyzer === "CV_VISION" ? cvState : analyzer === "AI_TEXT" ? textState : "done";
    return state === "done" ? null : { state, label: engineOutcomeLabels[state] };
  };

  const locationOf = useMemo(() => {
    return (row: RecentIssueRow) => getReportLocationStatus(issueStates?.[row.issue.id], locatorCheckState);
  }, [issueStates, locatorCheckState]);
  const summary = useMemo(() => summarizeReport(rows), [rows]);
  const engines = summary.analyzers.map((item) => ({ ...item, outcome: engineOutcome(item.analyzer) }));
  const allGroups = useMemo(() => groupByCriterion(rows), [rows]);
  const trend = useMemo(
    () => buildScoreTrend(evaluationRequests, target.id, resultSummaries, scoreResults),
    [evaluationRequests, target.id, resultSummaries, scoreResults]
  );
  const scoreChange = useMemo(() => compareWithPrevious(trend, requestId), [trend, requestId]);
  const criteriaOverview = useMemo(() => buildCriteriaOverview(rows, new Set<AnalyzerType>([
    "RULE_BASED",
    ...(textState === "done" ? ["AI_TEXT" as const] : []),
    ...(cvState === "done" ? ["CV_VISION" as const] : [])
  ]), new Set<AnalyzerType>([
    ...(textState === "unknown" ? ["AI_TEXT" as const] : []),
    ...(cvState === "unknown" ? ["CV_VISION" as const] : [])
  ])), [rows, textState, cvState]);
  const effectiveFilters = useMemo(
    () => getEffectiveReportFilters(filters, locatorCheckState),
    [filters, locatorCheckState]
  );
  const filteredRows = useMemo(
    () => filterReportRows(rows, effectiveFilters, locationOf),
    [rows, effectiveFilters, locationOf]
  );
  const filteredGroups = useMemo(() => groupByCriterion(filteredRows), [filteredRows]);
  // Paper always carries every issue: the search and severity filters are a
  // screen convenience, and the printed summary counts the whole report.
  const groups = isPrinting ? allGroups : filteredGroups;
  const filtersActive = effectiveFilters.severity !== "ALL" || effectiveFilters.analyzer !== "ALL" ||
    effectiveFilters.location !== "ALL" || effectiveFilters.query.trim().length > 0;

  // Printing and saving as PDF include every issue, independent of the
  // collapsed groups and pages the viewer currently uses on screen.
  useEffect(() => {
    if (!active) return;
    const expandForPrint = () => flushSync(() => setIsPrinting(true));
    const restoreAfterPrint = () => setIsPrinting(false);
    window.addEventListener("beforeprint", expandForPrint);
    window.addEventListener("afterprint", restoreAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", expandForPrint);
      window.removeEventListener("afterprint", restoreAfterPrint);
    };
  }, [active]);

  useEffect(() => {
    if (!focusRequest) return;
    const toggle = reportRef.current?.querySelector<HTMLButtonElement>(
      `[data-criterion-toggle="${CSS.escape(focusRequest.code)}"]`
    );
    setFocusRequest(null);
    if (!toggle) return;
    toggle.scrollIntoView({ block: "start" });
    toggle.focus({ preventScroll: true });
  }, [focusRequest]);

  function updateFilters(next: Partial<ReportFilters>) {
    const nextFilters = { ...filters, ...next };
    setFilters(nextFilters);
    const nextEffective = getEffectiveReportFilters(nextFilters, locatorCheckState);
    const nextActive = nextEffective.severity !== "ALL" || nextEffective.analyzer !== "ALL" ||
      nextEffective.location !== "ALL" || nextEffective.query.trim().length > 0;
    // Show matches immediately; collapsing a group afterwards stays possible.
    if (nextActive) {
      setExpandedCodes(new Set(groupByCriterion(filterReportRows(rows, nextEffective, locationOf)).map((group) => group.code)));
    }
  }

  function toggleGroup(code: string) {
    setExpandedCodes((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function showCriterion(code: string) {
    setFilters(defaultReportFilters);
    setExpandedCodes((current) => new Set(current).add(code));
    setFocusRequest({ code });
  }

  // The grid names criteria by number; the list may store them with a prefix.
  function showCriterionByCode(code: string) {
    const group = allGroups.find((candidate) => candidate.code.replace(/^KWCAG\s+/i, "") === code);
    if (group) showCriterion(group.code);
  }

  function printReport() {
    flushSync(() => setIsPrinting(true));
    window.print();
  }

  const allExpanded = groups.length > 0 && groups.every((group) => expandedCodes.has(group.code));

  return (
    <article ref={reportRef} className="site-final-report" aria-labelledby="site-final-report-heading">
      <header className="site-final-report__header">
        <div className="site-final-report__identity">
          <h2 id="site-final-report-heading" className="site-final-report__eyebrow">최종 리포트</h2>
          <p className="site-final-report__page-label" aria-hidden="true">분석 페이지</p>
          <p className="site-final-report__target">{target.name}</p>
          {/* Address and date read as labelled chips; the labels stay for
              screen readers while an icon carries them on screen. The print
              action sits on the same row as a chip-sized pill. */}
          <div className="site-final-report__meta-row">
            <dl className="site-final-report__meta">
              <div>
                <dt className="sr-only">페이지 주소</dt>
                <dd>
                  <a href={target.accessUrl} target="_blank" rel="noreferrer" data-copyable title={target.accessUrl}>
                    <span className="site-final-report__meta-text">{target.accessUrl.replace(/^https?:\/\//, "")}</span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                    <span className="sr-only">(새 창에서 열림)</span>
                  </a>
                </dd>
              </div>
              <div>
                <dt className="sr-only">분석 일시</dt>
                {/* Re-analysis rides in the date chip, as in the results view. */}
                <dd className={onRequestAnalysis ? "site-final-report__meta-date" : undefined}>
                  <CalendarClock size={14} aria-hidden="true" />
                  <span>{formatDateTime(analyzedAt)}</span>
                  {onRequestAnalysis && (
                    <button type="button" className="site-final-report__rescan"
                      onClick={onRequestAnalysis} disabled={isRequestingAnalysis} aria-busy={isRequestingAnalysis}
                      aria-describedby={analysisRequestError ? "site-final-report-analysis-error" : undefined}>
                      <RefreshCw size={12} aria-hidden="true" />
                      {isRequestingAnalysis ? "요청 중…" : "재분석"}
                    </button>
                  )}
                </dd>
              </div>
            </dl>
            <button type="button" className="site-final-report__print"
              onClick={printReport} disabled={loadState !== "ready"}>
              <Printer size={14} aria-hidden="true" />
              인쇄 · PDF 저장
            </button>
          </div>
        </div>
        {analysisRequestError && (
          <p id="site-final-report-analysis-error" className="site-final-report__header-error" role="alert">
            {analysisRequestError}
          </p>
        )}
      </header>

      {loadState === "loading" && (
        <p className="site-final-report__state" role="status">분석 결과를 불러오는 중입니다.</p>
      )}
      {loadState === "idle" && (
        <p className="site-final-report__state" role="status">완료된 분석 결과가 없습니다.</p>
      )}
      {loadState === "error" && (
        <div className="site-final-report__state" role="alert">
          <p>분석 결과를 불러오지 못해 리포트를 만들 수 없습니다.</p>
          {errorMessage && <p>{errorMessage}</p>}
          <button type="button" className="site-final-report__button" onClick={onRetry}>
            <RotateCcw size={16} aria-hidden="true" />
            다시 불러오기
          </button>
        </div>
      )}

      {loadState === "ready" && (
        <>
          {/* The figures open the report on large rounded tiles. */}
          <section className="site-final-report__section site-final-report__summary" aria-label="요약">
            <div className="site-final-report__tiles">
              <div className="site-final-report__tile site-final-report__tile--score">
                <div className="site-final-report__score-head">
                  <dl className="site-final-report__figure">
                    <div>
                      <dt>접근성 점수</dt>
                      <dd>
                        {score === null ? "미확인" : <>{formatScore(score)}<small>점</small></>}
                        {/* Shown only when the score moved; an unchanged score needs no note. */}
                        {scoreChange && scoreChange.scoreDelta !== 0 && (
                          <span className="site-final-report__score-change"
                            data-direction={scoreChange.scoreDelta > 0 ? "up" : "down"}>
                            <span aria-hidden="true">
                              {scoreChange.scoreDelta > 0 ? "+" : "−"}{formatScore(Math.abs(scoreChange.scoreDelta))}점
                            </span>
                            <span className="sr-only">
                              {`지난 분석(${scoreChange.previous.label})보다 ${formatScore(Math.abs(scoreChange.scoreDelta))}점 ${scoreChange.scoreDelta > 0 ? "올랐습니다" : "내렸습니다"}`}
                            </span>
                          </span>
                        )}
                      </dd>
                    </div>
                  </dl>
                  {trend.length > 1 && (
                    <p className="site-final-report__tile-note">최근 {trend.length.toLocaleString("ko-KR")}번의 분석 기록입니다.</p>
                  )}
                </div>
                <ReportScoreTrend items={trend} currentRequestId={requestId} printing={isPrinting} />
              </div>

              <div className="site-final-report__tile">
                <dl className="site-final-report__figure">
                  <div>
                    <dt>발견된 문제</dt>
                    <dd>{summary.total.toLocaleString("ko-KR")}<small>건</small></dd>
                  </div>
                </dl>
                {scoreChange?.issueDelta != null && (
                  <p className="site-final-report__delta" data-direction={direction(-scoreChange.issueDelta)}>
                    {scoreChange.issueDelta === 0
                      ? "지난 분석과 문제 수가 같습니다"
                      : `지난 분석보다 ${formatCount(Math.abs(scoreChange.issueDelta))} ${scoreChange.issueDelta < 0 ? "줄었습니다" : "늘었습니다"}`}
                  </p>
                )}
                <div className="site-final-report__severity-bar" aria-hidden="true">
                  {summary.severities.filter((item) => item.count > 0).map((item) => (
                    <span key={item.key} style={{ ...severityStyle(item.color), flexGrow: item.count }} />
                  ))}
                </div>
                <ul className="site-final-report__severity-list" aria-label="심각도별 문제 수">
                  {summary.severities.map((item) => (
                    <li key={item.key} style={severityStyle(item.color)}>
                      <span className="site-final-report__dot" aria-hidden="true" />
                      <span className="site-final-report__severity-name">{item.label}</span>
                      <strong>{formatCount(item.count)}</strong>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="site-final-report__tile">
                <dl className="site-final-report__figure">
                  <div>
                    <dt>검사 범위</dt>
                    <dd>{engines.filter((item) => !item.outcome).length}<small>/{engines.length} 완료</small></dd>
                  </div>
                </dl>
                <p className="site-final-report__delta">{describeEngineScope(engines.map((item) => item.outcome))}</p>
                <ul className="site-final-report__engine-list" aria-label="검사별 문제 수">
                  {engines.map((item) => (
                    <li key={item.analyzer}
                      data-outcome={!item.outcome ? "done" : item.outcome.state === "unknown" ? "unknown" : "incomplete"}>
                      {!item.outcome ? <CircleCheck size={16} aria-hidden="true" />
                        : item.outcome.state === "unknown" ? <CircleHelp size={16} aria-hidden="true" />
                          : <TriangleAlert size={16} aria-hidden="true" />}
                      <span>{item.label} 검사</span>
                      <strong>{item.outcome?.label ?? formatCount(item.count)}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {textFailed && (
              <p className="site-final-report__notice" role="note">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>텍스트 검사가 실패해 읽기 수준·링크 텍스트 등 문장 기반 문제는 이 리포트에 포함되지 않았고 점수에도 반영되지 않았습니다.</span>
              </p>
            )}
            {cvIncomplete && (
              <p className="site-final-report__notice" role="note">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>시각 검사가 {cvStatus === "FAILED" ? "실패해" : "측정되지 않아"} 명도 대비 등 화면 기반 문제는 이 리포트에 포함되지 않았을 수 있습니다.</span>
              </p>
            )}
            {unknownEngines.length > 0 && (
              <p className="site-final-report__notice" role="note">
                <CircleHelp size={16} aria-hidden="true" />
                <span>
                  {unknownEngines.map((analyzer) => `${analyzerLabels[analyzer]} 검사`).join("·")} 결과가 기록되지 않은 예전 분석이라
                  이 검사가 맡은 항목은 ‘확인 안 됨’으로 표시했습니다. 다시 분석하면 확인할 수 있어요.
                </span>
              </p>
            )}
          </section>

          <section className="site-final-report__section site-final-report__criteria" aria-labelledby="site-final-report-criteria">
            <ReportCriteriaOverview overview={criteriaOverview} onShowCriterion={showCriterionByCode} />
          </section>

          {summary.total === 0 ? (
            <section className="site-final-report__section" aria-labelledby="site-final-report-empty">
              <h3 id="site-final-report-empty" className="site-final-report__title">전체 문제</h3>
              <p className="site-final-report__state" role="status">
                {textFailed || cvIncomplete || unknownEngines.length > 0
                  ? "완료된 검사에서 발견된 문제가 없습니다. 일부 검사의 결과를 확인할 수 없으니 위 안내를 확인해 주세요."
                  : "이번 분석에서 발견된 문제가 없습니다. 자동 검사로 확인할 수 없는 항목은 직접 점검해 주세요."}
              </p>
            </section>
          ) : (
            <section className="site-final-report__section" aria-labelledby="site-final-report-issues">
              <h3 id="site-final-report-issues" className="site-final-report__title">
                문제 {formatCount(summary.total)}
              </h3>
              <ReportFilterControls
                filters={effectiveFilters}
                total={summary.total}
                severities={summary.severities}
                onChange={updateFilters}
              />
              <div className="site-final-report__list-bar">
                <p className="site-final-report__result-count" role="status">
                  {filtersActive
                    ? `전체 ${formatCount(summary.total)} 중 ${formatCount(filteredRows.length)}이 조건에 맞습니다.`
                    : `검사 항목 ${groups.length.toLocaleString("ko-KR")}개 · 문제 ${formatCount(summary.total)}`}
                </p>
                <button type="button" className="site-final-report__text-button"
                  onClick={() => setExpandedCodes(allExpanded ? new Set() : new Set(groups.map((group) => group.code)))}
                  disabled={groups.length === 0}>
                  {allExpanded ? "모두 접기" : "모두 펼치기"}
                </button>
              </div>
              {groups.length === 0 ? (
                <p className="site-final-report__state">조건에 맞는 문제가 없습니다.</p>
              ) : (
                <div className="site-final-report__groups">
                  {groups.map((group) => (
                    <CriterionGroup
                      key={group.code}
                      group={group}
                      printing={isPrinting}
                      expanded={isPrinting || expandedCodes.has(group.code)}
                      visibleCount={isPrinting ? group.rows.length : visibleCounts.get(group.code) ?? ISSUE_PAGE_SIZE}
                      deviceScaleFactor={deviceScaleFactor}
                      locationOf={locationOf}
                      onToggle={() => toggleGroup(group.code)}
                      onShowMore={() => setVisibleCounts((current) =>
                        new Map(current).set(group.code, (current.get(group.code) ?? ISSUE_PAGE_SIZE) + ISSUE_PAGE_SIZE))}
                      onShowOnPage={onShowOnPage}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
          <footer className="site-final-report__footnote">
            <p>
              자동 검사 결과이며 분석 당시 페이지를 기준으로 합니다. 열어야 보이는 메뉴·탭·팝업과 메뉴·머리글·바닥글의 문장은
              이번 검사에 포함되지 않았습니다. 표준 적합성은 전문가 점검과 함께 판단해 주세요.
            </p>
          </footer>
        </>
      )}
    </article>
  );
}

function ReportFilterControls({ filters, total, severities, onChange }: {
  filters: ReportFilters;
  total: number;
  severities: Array<SeverityChartItem & { count: number }>;
  onChange: (next: Partial<ReportFilters>) => void;
}) {
  const options: Array<{ value: ReportFilters["severity"]; label: string; count: number; color?: string }> = [
    { value: "ALL", label: "전체", count: total },
    ...severities.map((item) => ({ value: item.key, label: item.label, count: item.count, color: item.color }))
  ];
  return (
    // One toolbar row: a borderless search field, then severity chips that
    // carry their counts, the way a store page filters its catalog.
    <div className="site-final-report__filters" role="group" aria-label="문제 목록 필터">
      <label className="site-final-report__search">
        <span className="sr-only">검색</span>
        <Search size={16} aria-hidden="true" />
        <input type="search" value={filters.query} placeholder="제목, 문장, 요소 경로로 검색"
          onChange={(event) => onChange({ query: event.target.value })} />
      </label>
      <div className="site-final-report__chips" role="group" aria-label="심각도">
        {options.map((option) => (
          <button key={option.value} type="button" className="site-final-report__chip"
            aria-pressed={filters.severity === option.value}
            style={option.color ? severityStyle(option.color) : undefined}
            onClick={() => onChange({ severity: option.value })}>
            {option.color && <span className="site-final-report__dot" aria-hidden="true" />}
            <span>{option.label}</span>
            <span className="site-final-report__chip-count">{option.count.toLocaleString("ko-KR")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Bundles follow the order the summary lists the engines in.
const bundleOrder = ["RULE_BASED", "AI_TEXT", "CV_VISION", "OTHER"];

function CriterionGroup({
  group,
  printing,
  expanded,
  visibleCount,
  deviceScaleFactor,
  locationOf,
  onToggle,
  onShowMore,
  onShowOnPage
}: {
  group: ReportCriterionGroup;
  printing: boolean;
  expanded: boolean;
  visibleCount: number;
  deviceScaleFactor: number | null;
  locationOf: (row: RecentIssueRow) => ReportLocationStatus;
  onToggle: () => void;
  onShowMore: () => void;
  onShowOnPage: (issueId: number) => void;
}) {
  const listId = `site-final-report-criterion-${group.code.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const visibleRows = group.rows.slice(0, visibleCount);
  const remaining = group.rows.length - visibleRows.length;
  const about = describeCriterion(group.code);
  // Parse every finding once; the shared advice is read across all of them,
  // not only the page that is showing.
  const readings = useMemo(() => new Map(group.rows.map((row) => [row.issue.id, readIssue(row)])), [group.rows]);
  const shared = useMemo(
    () => buildSharedGuidance(group.rows, (row) => readings.get(row.issue.id) ?? readIssue(row)),
    [group.rows, readings]
  );
  // Paper splits a criterion that several engines reported into one bundle
  // per engine: its advice once, then its elements in a tight list.
  const bundles = useMemo(() => {
    if (!printing) return [];
    const byAnalyzer = new Map<string, RecentIssueRow[]>();
    for (const row of group.rows) {
      const key = row.analyzerType ?? "OTHER";
      const members = byAnalyzer.get(key);
      if (members) members.push(row);
      else byAnalyzer.set(key, [row]);
    }
    if (byAnalyzer.size < 2) return [{ key: "all", label: null, rows: group.rows, shared }];
    return [...byAnalyzer].sort(([left], [right]) => bundleOrder.indexOf(left) - bundleOrder.indexOf(right)).map(([key, rows]) => ({
      key,
      label: `${key in analyzerLabels ? analyzerLabels[key as AnalyzerType] : "기타"} 검사 ${formatCount(rows.length)}`,
      rows,
      shared: buildSharedGuidance(rows, (row) => readings.get(row.issue.id) ?? readIssue(row))
    }));
  }, [printing, group.rows, readings, shared]);

  return (
    <section className="site-final-report__group" style={severityStyle(group.severity.color)}>
      <h4>
        <button type="button" className="site-final-report__group-toggle" data-criterion-toggle={group.code}
          aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
          {group.codeLabel && <span className="site-final-report__code">{group.codeLabel}</span>}
          <span className="site-final-report__group-name">{group.title}</span>
          <span className="site-final-report__group-count">{formatCount(group.rows.length)}</span>
          <span className="site-final-report__plus" aria-hidden="true">
            {expanded ? <Minus size={14} /> : <Plus size={14} />}
          </span>
        </button>
      </h4>
      <div id={listId} className="site-final-report__group-body" hidden={!expanded}>
        {expanded && (
          <>
            {/* What the criterion asks; each finding's advice opens with it. */}
            {about && (
              <dl className="site-final-report__criterion-about">
                <div>
                  <dt>검사 기준</dt>
                  <dd>{about}</dd>
                </div>
              </dl>
            )}
            {printing ? bundles.map((bundle) => (
              // Paper says the advice a bundle's findings share once, above
              // them, instead of under each of them.
              <div key={bundle.key} className="site-final-report__bundle">
                {bundle.label && <p className="site-final-report__bundle-title">{bundle.label}</p>}
                {bundle.shared.entries.length > 0 && (
                  <dl className="site-final-report__criterion-about site-final-report__bundle-advice">
                    {bundle.shared.entries.map((entry) => (
                      <div key={entry.label}>
                        <dt>{entry.label}</dt>
                        <dd>{entry.body}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <ul className="site-final-report__issues" aria-label={`${group.title} ${bundle.label ?? "문제"} ${formatCount(bundle.rows.length)}`}>
                  {bundle.rows.map((row) => (
                    <ReportIssueItem key={row.issue.id} row={row} printing groupTitle={group.title}
                      reading={readings.get(row.issue.id)} shared={bundle.shared} location={locationOf(row)}
                      deviceScaleFactor={deviceScaleFactor} onShowOnPage={onShowOnPage} />
                  ))}
                </ul>
              </div>
            )) : (
              <ul className="site-final-report__issues" aria-label={`${group.title} 문제 ${formatCount(group.rows.length)}`}>
                {visibleRows.map((row) => (
                  <ReportIssueItem
                    key={row.issue.id}
                    row={row}
                    printing={printing}
                    groupTitle={group.title}
                    reading={readings.get(row.issue.id)}
                    shared={shared}
                    location={locationOf(row)}
                    deviceScaleFactor={deviceScaleFactor}
                    onShowOnPage={onShowOnPage}
                  />
                ))}
              </ul>
            )}
            {remaining > 0 && (
              <div className="site-final-report__more-row">
                <button type="button" className="site-final-report__more" onClick={onShowMore}>
                  {formatCount(Math.min(ISSUE_PAGE_SIZE, remaining))} 더 보기
                  <span className="site-final-report__more-count">남은 문제 {formatCount(remaining)}</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ReportIssueItem({
  row, groupTitle, printing, reading: givenReading, shared, location, deviceScaleFactor, onShowOnPage
}: {
  row: RecentIssueRow;
  groupTitle: string;
  /** Printing opens every finding; the group header carries the shared advice. */
  printing: boolean;
  deviceScaleFactor: number | null;
  reading?: IssueReading;
  /** The group's shared advice, which this finding does not repeat. */
  shared?: SharedGuidance;
  location?: ReportLocationStatus;
  onShowOnPage?: (issueId: number) => void;
}) {
  const { issue } = row;
  const [open, setOpen] = useState(false);
  const expanded = open || printing;
  const [htmlToggled, setHtmlExpanded] = useState(false);
  // Paper prints the whole stored HTML so a developer can read every attribute.
  const htmlExpanded = htmlToggled || printing;
  const reading = useMemo(() => givenReading ?? readIssue(row), [givenReading, row]);
  const line = useMemo(() => describeIssueLine(row, reading, shared), [row, reading, shared]);
  // The group header already prints the shared advice.
  const details = printing && shared ? line.details.filter((part) => !shared.isShared(row, part)) : line.details;
  const issueLocation = useMemo(() => describeIssueLocation(issue, deviceScaleFactor), [issue, deviceScaleFactor]);
  const locator = issue.locator;
  const carousel = locator?.carouselContext;
  const content = locator?.content;
  const html = locator?.htmlSnippet?.trim() ?? "";
  const htmlTruncated = html.length > HTML_PREVIEW_LIMIT;
  const htmlShown = htmlTruncated && !htmlExpanded ? `${html.slice(0, HTML_PREVIEW_LIMIT)}…` : html;
  const title = issue.issueTitle || groupTitle;
  const detailsId = `site-final-report-issue-${issue.id}`;

  return (
    <li className="site-final-report__issue" style={severityStyle(row.severity.color)} data-issue-id={issue.id}
      data-location-status={location} data-expanded={expanded}>
      {/* One line per finding: its severity, its own words and the one number
          that matters; the rest opens underneath. */}
      <div className="site-final-report__issue-line">
        {/* The toggle stretches over the whole line, so the page link can sit
            right after the title and still be its own button. */}
        <span className="site-final-report__severity" aria-hidden="true">{row.severity.label}</span>
        <span className="site-final-report__issue-main">
          <span className="site-final-report__issue-head">
            <button type="button" className="site-final-report__issue-toggle" aria-expanded={expanded}
              aria-controls={detailsId} onClick={() => setOpen((current) => !current)}>
              <span className="sr-only">{row.severity.label} </span>
              <span className="site-final-report__issue-title">{line.title}</span>
            </button>
            {location && onShowOnPage && canShowOnPage(location) && (
              <button type="button" className="site-final-report__show-on-page" onClick={() => onShowOnPage(issue.id)}>
                페이지에서 보기 ›
                <span className="sr-only">: {title}</span>
              </button>
            )}
          </span>
          {line.context && (
            <span className="site-final-report__issue-sub">
              <span className="site-final-report__issue-context">{line.context}</span>
            </span>
          )}
          {line.metrics.length > 0 && (
            <span className="site-final-report__metrics-row">
              {line.metrics.map((metric) => <span key={metric} className="site-final-report__metric">{metric}</span>)}
            </span>
          )}
        </span>
        {reading.contrast && (
          <span className="site-final-report__ratio">
            <span className="sr-only">명도 대비</span>
            <strong>{reading.contrast.contrast || "측정값 없음"}</strong>
            <span>{reading.contrast.required ? `기준 ${reading.contrast.required} 이상` : "기준 정보 없음"}</span>
          </span>
        )}
        <ChevronDown size={16} aria-hidden="true" className="site-final-report__chevron" />
      </div>

      <div id={detailsId} className="site-final-report__issue-details" hidden={!expanded}>
        {expanded && (
          <>
            {line.compare && (
              <div className="site-final-report__compare" data-copyable>
                <div>
                  <p className="site-final-report__compare-label">원래 문장</p>
                  <p>{line.compare.before}</p>
                </div>
                <div>
                  <p className="site-final-report__compare-label site-final-report__compare-label--after">이렇게 바꿔 보세요</p>
                  <p>{line.compare.after}</p>
                </div>
                {line.compare.reason && <p className="site-final-report__compare-reason">{line.compare.reason}</p>}
              </div>
            )}
            {details.length > 0 && (
              <dl className="site-final-report__guide" data-copyable>
                {details.map((part, index) => (
                  <div key={index}>
                    <dt>{partLabel(part)}</dt>
                    <dd>{part.body}</dd>
                  </div>
                ))}
              </dl>
            )}
            <dl className="site-final-report__code-location">
              <div>
                <dt>코드 위치</dt>
                <dd>
                  {issueLocation === null ? "저장된 위치 정보가 없습니다." : issueLocation.kind === "path" ? (
                    <ol>
                      {issueLocation.steps.map((step, index) => (
                        <li key={index}>
                          {issueLocation.steps.length > 1 || step.context !== "DOCUMENT"
                            ? <span className="site-final-report__context">{contextLabel(step.context)}</span>
                            : null}
                          <code data-copyable>{step.selector}</code>
                          {step.frameUrl && <span className="site-final-report__frame-url" data-copyable>{step.frameUrl}</span>}
                        </li>
                      ))}
                    </ol>
                  ) : issueLocation.kind === "coordinates" ? (
                    <span data-copyable>
                      화면 좌표 x {issueLocation.x}, y {issueLocation.y}
                      {issueLocation.width !== null && issueLocation.height !== null
                        ? ` · ${issueLocation.width}×${issueLocation.height}`
                        : ""} (요소 경로 없음)
                    </span>
                  ) : <code data-copyable>{issueLocation.value}</code>}
                </dd>
              </div>
              {carousel && (
                <div>
                  <dt>슬라이드</dt>
                  <dd>분석 당시 {carousel.slideCount}장 중 {carousel.slideIndex + 1}번째 슬라이드</dd>
                </div>
              )}
              {content && (content.text || content.image) && (
                <div>
                  <dt>분석 당시 내용</dt>
                  <dd data-copyable>
                    {content.text && <span className="site-final-report__content-line">글자 {content.text}</span>}
                    {content.image && <span className="site-final-report__content-line">이미지 <code>{content.image}</code></span>}
                  </dd>
                </div>
              )}
              {html && (
                <div>
                  <dt>분석 당시 HTML</dt>
                  <dd>
                    <pre data-copyable><code>{htmlShown}</code></pre>
                    {htmlTruncated && (
                      <button type="button" className="site-final-report__button site-final-report__link site-final-report__html-toggle"
                        aria-expanded={htmlExpanded} onClick={() => setHtmlExpanded((current) => !current)}>
                        {htmlExpanded ? "HTML 줄여 보기" : `HTML 전체 보기 (${html.length.toLocaleString("ko-KR")}자)`}
                      </button>
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </>
        )}
      </div>
    </li>
  );
}
