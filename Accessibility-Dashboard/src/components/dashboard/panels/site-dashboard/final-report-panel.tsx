import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  FileText,
  Info,
  LocateFixed,
  LocateOff,
  Printer,
  RotateCcw,
  TriangleAlert
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";

import type {
  AnalyzerType,
  EvaluationRequestModel,
  EvaluationResultSummary,
  EvaluationTargetModel,
  IssueExclusionReason,
  ScoreResult,
  SeverityLevel
} from "@/types/accessibility-domain";

import { formatDateTime } from "../../shared/utils";
import { severityChartItems } from "./constants";
import {
  analyzerLabels,
  buildFixPriorities,
  canShowOnPage,
  countUrgent,
  defaultReportFilters,
  describeIssueLocation,
  filterReportRows,
  getEffectiveReportFilters,
  getReportLocationStatus,
  groupByCriterion,
  parseContrastMessage,
  splitDescriptionSections,
  summarizeReport,
  summarizeReportLocations,
  type ReportCriterionGroup,
  type ReportFilters,
  type ReportLocationStatus
} from "./final-report";
import { getIssueCoordinateBox } from "./issue-locator";
import { buildCriteriaOverview } from "./kwcag-criteria";
import { getLocatorExplanation, hasLocatorPresentation } from "./locator-explanation";
import { isChangedAfterAnalysis } from "./locator-labels";
import { formatIssueDescription } from "./page-replay-protocol";
import { ReportCriteriaOverview } from "./report-criteria-overview";
import { ReportScoreTrend } from "./report-score-trend";
import { buildScoreTrend, compareWithPrevious } from "./score-trend";
import type { LocatorCheckState, LocatorIssueState, RecentIssueRow } from "./types";
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
  /** Findings in advertising or changing regions, reported outside the score. */
  excludedRows?: RecentIssueRow[];
  loadState: EvaluationResultDetailsLoadState;
  errorMessage: string | null;
  onRetry: () => void;
  locatorCheckState: LocatorCheckState;
  issueStates?: Record<number, LocatorIssueState>;
  onShowOnPage: (issueId: number) => void;
  onShowDetails: (issueId: number) => void;
  /** Capture pixel scale, so screenshot coordinates read like the page markers. */
  deviceScaleFactor?: number | null;
};

function formatCount(count: number): string {
  return `${count.toLocaleString("ko-KR")}건`;
}

function formatScore(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
}

function formatShare(count: number, total: number): string {
  return total > 0 ? `${Math.round((count / total) * 100)}%` : "0%";
}

/** Positive means better for the reader: a higher score or fewer issues. */
function direction(better: number): "better" | "worse" | "same" {
  return better > 0 ? "better" : better < 0 ? "worse" : "same";
}

function severityStyle(color: string): CSSProperties {
  return { "--site-report-severity-color": color } as CSSProperties;
}

function locationLabel(status: ReportLocationStatus, state?: LocatorIssueState): string {
  switch (status) {
    case "checking":
      return "위치 확인 중";
    case "disconnected":
      return "현재 페이지 연결 안 됨";
    case "on-page":
      return hasLocatorPresentation(state)
        ? `페이지에서 확인 가능 · ${getLocatorExplanation(state).label}`
        : "페이지에서 확인 가능";
    case "other-state":
      return `다른 화면 상태에서 확인 가능 · ${getLocatorExplanation(state).label}`;
    case "page-setting":
      return "페이지 전체 설정 · 화면 위치 없음";
    case "unavailable":
      return `위치 표시 불가 · ${getLocatorExplanation(state).label}`;
  }
}

const exclusionLabels: Record<IssueExclusionReason, string> = { AD: "광고", DYNAMIC: "동적 영역", POPUP: "레이어 팝업" };

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
  excludedRows = [],
  loadState,
  errorMessage,
  onRetry,
  locatorCheckState,
  issueStates,
  onShowOnPage,
  onShowDetails,
  deviceScaleFactor = null
}: FinalReportPanelProps) {
  const [filters, setFilters] = useState<ReportFilters>(defaultReportFilters);
  const [expandedCodes, setExpandedCodes] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleCounts, setVisibleCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [isPrinting, setIsPrinting] = useState(false);
  const [excludedExpanded, setExcludedExpanded] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ code: string } | null>(null);
  const reportRef = useRef<HTMLElement>(null);
  // A measured zero is a real score; only a missing result is unknown.
  const scoreResult = requestId === null ? undefined : scoreResults.find((result) => result.evaluationRequestId === requestId);
  const score = scoreResult?.totalScore ??
    resultSummaries.find((summary) => summary.requestId === requestId)?.totalScore ?? null;
  const cvStatus = scoreResult?.cvStatus ?? null;
  const textFailed = scoreResult?.textStatus === "FAILED";
  const cvIncomplete = cvStatus === "NOT_MEASURED" || cvStatus === "FAILED";
  // An engine that did not run reports no issues; show that instead of "0건".
  const engineOutcome = (analyzer: AnalyzerType): string | null =>
    analyzer === "CV_VISION" && cvIncomplete ? (cvStatus === "FAILED" ? "검사 실패" : "측정 안 됨")
      : analyzer === "AI_TEXT" && textFailed ? "검사 실패"
        : null;

  const locationOf = useMemo(() => {
    return (row: RecentIssueRow) => getReportLocationStatus(issueStates?.[row.issue.id], locatorCheckState);
  }, [issueStates, locatorCheckState]);
  const summary = useMemo(() => summarizeReport(rows), [rows]);
  const locationSummary = useMemo(() => summarizeReportLocations(rows, locationOf), [rows, locationOf]);
  const changedAfterAnalysisCount = useMemo(
    () => rows.filter((row) => isChangedAfterAnalysis(issueStates?.[row.issue.id])).length,
    [rows, issueStates]
  );
  const priorities = useMemo(() => buildFixPriorities(rows), [rows]);
  const allGroups = useMemo(() => groupByCriterion(rows), [rows]);
  const urgentCount = countUrgent(summary);
  const trend = useMemo(
    () => buildScoreTrend(evaluationRequests, target.id, resultSummaries, scoreResults),
    [evaluationRequests, target.id, resultSummaries, scoreResults]
  );
  const scoreChange = useMemo(() => compareWithPrevious(trend, requestId), [trend, requestId]);
  const criteriaOverview = useMemo(() => buildCriteriaOverview(rows, new Set<AnalyzerType>([
    "RULE_BASED",
    ...(textFailed ? [] : ["AI_TEXT" as const]),
    ...(cvIncomplete ? [] : ["CV_VISION" as const])
  ])), [rows, textFailed, cvIncomplete]);
  const effectiveFilters = useMemo(
    () => getEffectiveReportFilters(filters, locatorCheckState),
    [filters, locatorCheckState]
  );
  const filteredRows = useMemo(
    () => filterReportRows(rows, effectiveFilters, locationOf),
    [rows, effectiveFilters, locationOf]
  );
  const groups = useMemo(() => groupByCriterion(filteredRows), [filteredRows]);
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
          <p className="site-final-report__target">{target.name}</p>
          <dl className="site-final-report__meta">
            <div>
              <dt>페이지 주소</dt>
              <dd><a href={target.accessUrl} target="_blank" rel="noreferrer" data-copyable>{target.accessUrl}</a></dd>
            </div>
            <div>
              <dt>분석 일시</dt>
              <dd>{formatDateTime(analyzedAt)}</dd>
            </div>
          </dl>
        </div>
        <div className="site-final-report__actions">
          <button type="button" className="site-final-report__button site-final-report__button--primary"
            onClick={printReport} disabled={loadState !== "ready"}>
            <Printer size={16} aria-hidden="true" />
            인쇄 · PDF 저장
          </button>
        </div>
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
          <section className="site-final-report__section site-final-report__summary" aria-labelledby="site-final-report-summary">
            <h3 id="site-final-report-summary" className="site-final-report__kicker">요약</h3>
            <p className="site-final-report__headline">
              {summary.total === 0
                ? "발견된 문제가 없습니다"
                : `검사 항목 ${allGroups.length.toLocaleString("ko-KR")}개에서 문제 ${formatCount(summary.total)}을 발견했습니다`}
            </p>
            <p className="site-final-report__lead">
              {summary.total === 0 ? "자동 검사로 확인할 수 없는 항목은 직접 점검해 주세요."
                : urgentCount > 0 ? `심각·높음 문제 ${formatCount(urgentCount)}은 이용 자체를 막을 수 있어 먼저 고치는 것을 권장합니다.`
                  : "심각하거나 높은 문제는 없습니다. 중간·낮음 문제를 차례로 개선해 주세요."}
            </p>

            <div className="site-final-report__tiles">
              <div className="site-final-report__tile site-final-report__tile--score">
                <dl className="site-final-report__figure">
                  <div>
                    <dt>접근성 점수</dt>
                    <dd>{score === null ? "미확인" : <>{formatScore(score)}<small>점</small></>}</dd>
                  </div>
                </dl>
                {scoreChange && (
                  <p className="site-final-report__delta" data-direction={direction(scoreChange.scoreDelta)}>
                    {scoreChange.scoreDelta === 0
                      ? `지난 분석(${scoreChange.previous.label})과 같습니다`
                      : `지난 분석(${scoreChange.previous.label})보다 ${formatScore(Math.abs(scoreChange.scoreDelta))}점 ${scoreChange.scoreDelta > 0 ? "올랐습니다" : "내렸습니다"}`}
                  </p>
                )}
                <ReportScoreTrend items={trend} currentRequestId={requestId} />
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
                      <span className="site-final-report__share">{formatShare(item.count, summary.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="site-final-report__tile">
                <h4>검사 범위</h4>
                <ul className="site-final-report__engine-list">
                  {summary.analyzers.map((item) => {
                    const outcome = engineOutcome(item.analyzer);
                    return (
                      <li key={item.analyzer} data-outcome={outcome ? "incomplete" : "done"}>
                        {outcome ? <TriangleAlert size={16} aria-hidden="true" /> : <CircleCheck size={16} aria-hidden="true" />}
                        <span>{item.label} 검사</span>
                        <strong>{outcome ?? formatCount(item.count)}</strong>
                      </li>
                    );
                  })}
                </ul>
                <dl className="site-final-report__metrics">
                  <div>
                    <dt>페이지에서 확인 가능</dt>
                    <dd>{locatorCheckState === "ready"
                      ? formatCount(locationSummary["on-page"] + locationSummary["other-state"])
                      : locatorCheckState === "error" ? "연결 안 됨" : "확인 중"}</dd>
                  </div>
                  <div>
                    <dt>위치 표시 불가</dt>
                    <dd>{locatorCheckState === "ready"
                      ? formatCount(locationSummary.unavailable + locationSummary["page-setting"])
                      : locatorCheckState === "error" ? "연결 안 됨" : "확인 중"}</dd>
                  </div>
                  <div>
                    <dt>점수에서 제외</dt>
                    <dd>{formatCount(excludedRows.length)}</dd>
                  </div>
                </dl>
              </div>
            </div>
            {textFailed && (
              <p className="site-final-report__notice" role="note">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>텍스트 검사가 실패해 읽기 수준·링크 텍스트 등 문장 기반 문제는 이 리포트에 포함되지 않았고 점수에도 반영되지 않았습니다.</span>
              </p>
            )}
            {locatorCheckState === "ready" && changedAfterAnalysisCount > 0 && (
              <p className="site-final-report__notice" role="note">
                분석 이후 페이지 내용이 바뀌어 문제 {formatCount(changedAfterAnalysisCount)}의 위치를 현재 페이지에서 찾지 못했습니다.
                최신 결과를 보려면 페이지를 재분석해 주세요.
              </p>
            )}
            {cvIncomplete && (
              <p className="site-final-report__notice" role="note">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>시각 검사가 {cvStatus === "FAILED" ? "실패해" : "측정되지 않아"} 명도 대비 등 화면 기반 문제는 이 리포트에 포함되지 않았을 수 있습니다.</span>
              </p>
            )}

            <ReportCriteriaOverview overview={criteriaOverview} onShowCriterion={showCriterionByCode} />

            {priorities.length > 0 && (
              <div className="site-final-report__priority-block">
                <h4 id="site-final-report-priorities">먼저 고칠 항목</h4>
                <p className="site-final-report__lead">
                  같은 방법으로 고칠 수 있는 문제를 묶고, 심각도와 건수를 함께 고려해 순서를 정했습니다.
                </p>
                <div className="site-final-report__priority-head" aria-hidden="true">
                  <span>순위</span>
                  <span>심각도</span>
                  <span>고칠 항목</span>
                  <span>건수</span>
                  <span />
                </div>
                <ol className="site-final-report__priorities" aria-labelledby="site-final-report-priorities">
                  {priorities.map((unit) => (
                    <li key={unit.key} style={severityStyle(unit.severity.color)}>
                      <span className="site-final-report__priority-severity">
                        <span className="site-final-report__severity">{unit.severity.label}</span>
                      </span>
                      <div className="site-final-report__priority-body">
                        <p className="site-final-report__priority-title">{unit.title}</p>
                        <p className="site-final-report__tags">
                          {unit.codeLabel && <span className="site-final-report__code">{unit.codeLabel}</span>}
                          <span>{unit.analyzers.map((analyzer) => analyzerLabels[analyzer]).join(" · ")} 검사</span>
                        </p>
                      </div>
                      <strong className="site-final-report__priority-count">{formatCount(unit.count)}</strong>
                      <button type="button" className="site-final-report__button site-final-report__link"
                        onClick={() => showCriterion(unit.code)}>
                        목록에서 보기
                        <ChevronRight size={16} aria-hidden="true" />
                        <span className="sr-only">: {unit.title}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>

          {summary.total === 0 ? (
            <section className="site-final-report__section" aria-labelledby="site-final-report-empty">
              <h3 id="site-final-report-empty" className="site-final-report__kicker">전체 문제</h3>
              <p className="site-final-report__state" role="status">
                {textFailed || cvIncomplete
                  ? "완료된 검사에서 발견된 문제가 없습니다. 일부 검사를 하지 못했으니 위 안내를 확인해 주세요."
                  : "이번 분석에서 발견된 문제가 없습니다. 자동 검사로 확인할 수 없는 항목은 직접 점검해 주세요."}
              </p>
            </section>
          ) : (
            <>
              <section className="site-final-report__section" aria-labelledby="site-final-report-issues">
                <div className="site-final-report__section-heading">
                  <div>
                    <h3 id="site-final-report-issues" className="site-final-report__kicker">전체 문제</h3>
                    <p className="site-final-report__headline site-final-report__headline--section">
                      문제 {formatCount(summary.total)}의 설명과 위치
                    </p>
                    <p className="site-final-report__lead">
                      KWCAG 검사 항목별로 묶었습니다. 항목을 펼치면 문제마다 판단 이유, 개선 방법, 분석 당시 위치와 HTML을 볼 수 있습니다.
                    </p>
                  </div>
                </div>
                <ReportFilterControls
                  filters={effectiveFilters}
                  locationReady={locatorCheckState === "ready"}
                  onChange={updateFilters}
                />
                <div className="site-final-report__list-bar">
                  <p className="site-final-report__result-count" role="status">
                    {filtersActive
                      ? `전체 ${formatCount(summary.total)} 중 ${formatCount(filteredRows.length)}이 조건에 맞습니다.`
                      : `검사 항목 ${groups.length.toLocaleString("ko-KR")}개, 문제 ${formatCount(summary.total)}`}
                  </p>
                  <button type="button" className="site-final-report__button site-final-report__link"
                    onClick={() => setExpandedCodes(allExpanded ? new Set() : new Set(groups.map((group) => group.code)))}
                    disabled={groups.length === 0}>
                    <ChevronsUpDown size={16} aria-hidden="true" />
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
                        issueStates={issueStates}
                        deviceScaleFactor={deviceScaleFactor}
                        locationOf={locationOf}
                        onToggle={() => toggleGroup(group.code)}
                        onShowMore={() => setVisibleCounts((current) =>
                          new Map(current).set(group.code, (current.get(group.code) ?? ISSUE_PAGE_SIZE) + ISSUE_PAGE_SIZE))}
                        onShowOnPage={onShowOnPage}
                        onShowDetails={onShowDetails}
                      />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
          {excludedRows.length > 0 && (
            <ExcludedIssues rows={excludedRows} printing={isPrinting} expanded={isPrinting || excludedExpanded}
              showAll={isPrinting} deviceScaleFactor={deviceScaleFactor}
              onToggle={() => setExcludedExpanded((current) => !current)} />
          )}
          <footer className="site-final-report__footnote">
            <Info size={16} aria-hidden="true" />
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

const severityOptions: Array<{ value: ReportFilters["severity"]; label: string }> = [
  { value: "ALL", label: "전체 심각도" },
  ...severityChartItems.map((item) => ({ value: item.key as SeverityLevel, label: item.label }))
];
const analyzerOptions: Array<{ value: ReportFilters["analyzer"]; label: string }> = [
  { value: "ALL", label: "전체 엔진" },
  ...(Object.entries(analyzerLabels) as Array<[AnalyzerType, string]>).map(([value, label]) => ({ value, label: `${label} 검사` }))
];
const locationOptions: Array<{ value: ReportFilters["location"]; label: string }> = [
  { value: "ALL", label: "전체 위치 상태" },
  { value: "on-page", label: "페이지에서 확인 가능" },
  { value: "page-setting", label: "페이지 전체 설정" },
  { value: "unavailable", label: "위치 표시 불가" }
];

function ReportFilterControls({ filters, locationReady, onChange }: {
  filters: ReportFilters;
  locationReady: boolean;
  onChange: (next: Partial<ReportFilters>) => void;
}) {
  return (
    <div className="site-final-report__filters" role="group" aria-label="문제 목록 필터">
      <label>
        <span>심각도</span>
        <select value={filters.severity} onChange={(event) => onChange({ severity: event.target.value as ReportFilters["severity"] })}>
          {severityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label>
        <span>검사 엔진</span>
        <select value={filters.analyzer} onChange={(event) => onChange({ analyzer: event.target.value as ReportFilters["analyzer"] })}>
          {analyzerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label>
        <span>위치 상태</span>
        <select value={filters.location} disabled={!locationReady} aria-describedby={locationReady ? undefined : "site-final-report-location-hint"}
          onChange={(event) => onChange({ location: event.target.value as ReportFilters["location"] })}>
          {locationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="site-final-report__search">
        <span>검색</span>
        <input type="search" value={filters.query} placeholder="제목, 검사 항목, 요소 경로"
          onChange={(event) => onChange({ query: event.target.value })} />
      </label>
      {!locationReady && (
        <p id="site-final-report-location-hint" className="site-final-report__hint">
          현재 페이지에서 문제 위치를 확인한 뒤 위치 상태로 거를 수 있습니다.
        </p>
      )}
    </div>
  );
}

function CriterionGroup({
  group,
  printing,
  expanded,
  visibleCount,
  issueStates,
  deviceScaleFactor,
  locationOf,
  onToggle,
  onShowMore,
  onShowOnPage,
  onShowDetails
}: {
  group: ReportCriterionGroup;
  printing: boolean;
  expanded: boolean;
  visibleCount: number;
  issueStates?: Record<number, LocatorIssueState>;
  deviceScaleFactor: number | null;
  locationOf: (row: RecentIssueRow) => ReportLocationStatus;
  onToggle: () => void;
  onShowMore: () => void;
  onShowOnPage: (issueId: number) => void;
  onShowDetails: (issueId: number) => void;
}) {
  const listId = `site-final-report-criterion-${group.code.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const visibleRows = group.rows.slice(0, visibleCount);
  const remaining = group.rows.length - visibleRows.length;

  return (
    <section className="site-final-report__group" style={severityStyle(group.severity.color)}>
      <h4>
        <button type="button" className="site-final-report__group-toggle" data-criterion-toggle={group.code}
          aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
          <ChevronDown size={18} aria-hidden="true" className="site-final-report__chevron" />
          <span className="site-final-report__group-title">
            <span className="site-final-report__group-name">
              {group.codeLabel && <span className="site-final-report__code">{group.codeLabel}</span>}
              <span>{group.title}</span>
            </span>
            <span className="site-final-report__group-breakdown">
              {[
                ...group.severityCounts.map((item) => `${item.label} ${formatCount(item.count)}`),
                `${group.analyzers.map((analyzer) => analyzerLabels[analyzer]).join(" · ")} 검사`
              ].join(" · ")}
            </span>
          </span>
          <span className="site-final-report__group-meta">
            <span className="site-final-report__severity">최고 {group.severity.label}</span>
            <span>{formatCount(group.rows.length)}</span>
          </span>
        </button>
      </h4>
      <div id={listId} hidden={!expanded}>
        {expanded && (
          <>
            <ul className="site-final-report__issues">
              {visibleRows.map((row) => (
                <ReportIssueItem
                  key={row.issue.id}
                  row={row}
                  printing={printing}
                  groupTitle={group.title}
                  location={locationOf(row)}
                  state={issueStates?.[row.issue.id]}
                  deviceScaleFactor={deviceScaleFactor}
                  onShowOnPage={onShowOnPage}
                  onShowDetails={onShowDetails}
                />
              ))}
            </ul>
            {remaining > 0 && (
              <button type="button" className="site-final-report__button site-final-report__more" onClick={onShowMore}>
                {formatCount(Math.min(ISSUE_PAGE_SIZE, remaining))} 더 보기
                <span className="site-final-report__more-count">(남은 문제 {formatCount(remaining)})</span>
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ExcludedIssues({ rows, printing, expanded, showAll, deviceScaleFactor, onToggle }: {
  rows: RecentIssueRow[];
  printing: boolean;
  expanded: boolean;
  /** Printing includes every excluded finding. */
  showAll: boolean;
  deviceScaleFactor: number | null;
  onToggle: () => void;
}) {
  const [visibleCount, setVisibleCount] = useState(ISSUE_PAGE_SIZE);
  const visibleRows = showAll ? rows : rows.slice(0, visibleCount);
  const remaining = rows.length - visibleRows.length;
  const counts = (Object.keys(exclusionLabels) as IssueExclusionReason[])
    .map((reason) => [reason, rows.filter(({ issue }) => issue.exclusionReason === reason).length] as const)
    .filter(([, count]) => count > 0);
  return (
    <section className="site-final-report__section" aria-labelledby="site-final-report-excluded">
      <h3 id="site-final-report-excluded">
        <button type="button" className="site-final-report__section-toggle" aria-expanded={expanded}
          aria-controls="site-final-report-excluded-list" onClick={onToggle}>
          <span className="site-final-report__section-toggle-title">점수에서 제외된 문제</span>
          <span className="site-final-report__section-toggle-meta">
            {counts.map(([reason, count]) => `${exclusionLabels[reason]} ${formatCount(count)}`).join(" · ")}
          </span>
          <ChevronDown size={18} aria-hidden="true" className="site-final-report__chevron" />
        </button>
      </h3>
      <p className="site-final-report__lead">
        광고와 다시 불러올 때마다 내용이 바뀌는 영역(뉴스·상품 추천 등)은 사이트의 고정 콘텐츠가 아니어서
        점수와 문제 수에서 뺐습니다. 처음 접속할 때 본문을 가리는 레이어 팝업은 따로 검사한 뒤 닫고 본문을
        평가했으며, 팝업의 문제도 여기에 모았습니다. 고정 배너와 슬라이드 배너는 그대로 검사합니다.
      </p>
      <div id="site-final-report-excluded-list" className="site-final-report__excluded-list" hidden={!expanded}>
        {expanded && (
          <>
            <ul className="site-final-report__issues">
              {visibleRows.map((row) => (
                <ReportIssueItem key={row.issue.id} row={row} groupTitle="" printing={printing}
                  deviceScaleFactor={deviceScaleFactor} />
              ))}
            </ul>
            {remaining > 0 && (
              <button type="button" className="site-final-report__button site-final-report__more"
                onClick={() => setVisibleCount((current) => current + ISSUE_PAGE_SIZE)}>
                {formatCount(Math.min(ISSUE_PAGE_SIZE, remaining))} 더 보기
                <span className="site-final-report__more-count">(남은 문제 {formatCount(remaining)})</span>
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ReportIssueItem({ row, groupTitle, printing, location, state, deviceScaleFactor, onShowOnPage, onShowDetails }: {
  row: RecentIssueRow;
  groupTitle: string;
  /** Printing shows the whole stored HTML instead of the preview. */
  printing: boolean;
  deviceScaleFactor: number | null;
  /** Location and actions are absent for excluded findings, which have no marker on the page. */
  location?: ReportLocationStatus;
  state?: LocatorIssueState;
  onShowOnPage?: (issueId: number) => void;
  onShowDetails?: (issueId: number) => void;
}) {
  const { issue } = row;
  const [htmlToggled, setHtmlExpanded] = useState(false);
  const htmlExpanded = htmlToggled || printing;
  // Filters and locator updates re-render every visible item; parse each
  // description once per issue instead.
  const formattedDescription = useMemo(
    () => formatIssueDescription(issue.message, row.analyzerType, issue.ruleId),
    [issue.message, issue.ruleId, row.analyzerType]
  );
  const descriptionSections = useMemo(() => splitDescriptionSections(formattedDescription), [formattedDescription]);
  // Rule findings are shown in Korean; the engine's own wording stays available.
  const engineOriginal = row.analyzerType === "RULE_BASED" && formattedDescription !== issue.message.trim()
    ? issue.message.trim() : "";
  const contrast = row.analyzerType === "CV_VISION" ? parseContrastMessage(issue.message) : null;
  const issueLocation = useMemo(() => describeIssueLocation(issue, deviceScaleFactor), [issue, deviceScaleFactor]);
  const locator = issue.locator;
  const carousel = locator?.carouselContext;
  const content = locator?.content;
  const html = locator?.htmlSnippet?.trim() ?? "";
  const htmlTruncated = html.length > HTML_PREVIEW_LIMIT;
  const htmlShown = htmlTruncated && !htmlExpanded ? `${html.slice(0, HTML_PREVIEW_LIMIT)}…` : html;
  const title = issue.issueTitle || groupTitle;
  const explained = location === "on-page" || location === "other-state" || location === "page-setting" || location === "unavailable";
  const explanation = explained
    ? getLocatorExplanation(state, { coordinateOnly: getIssueCoordinateBox(issue) !== null })
    : null;

  return (
    <li className="site-final-report__issue" style={severityStyle(row.severity.color)} data-issue-id={issue.id}
      data-location-status={location}>
      <div className="site-final-report__issue-head">
        <p className="site-final-report__tags">
          <span className="site-final-report__severity">{row.severity.label}</span>
          {row.analyzerType && <span>{analyzerLabels[row.analyzerType]} 검사</span>}
          {issue.ruleId && <span>규칙 <code className="site-final-report__rule" data-copyable>{issue.ruleId}</code></span>}
          {issue.exclusionReason && <span className="site-final-report__code">{exclusionLabels[issue.exclusionReason]}</span>}
          <span className="site-final-report__issue-id" data-copyable>문제 번호 {issue.id}</span>
        </p>
        {location && (
          <span className="site-final-report__location" data-location-status={location}>
            {canShowOnPage(location)
              ? <LocateFixed size={14} aria-hidden="true" />
              : location === "unavailable" ? <LocateOff size={14} aria-hidden="true" /> : null}
            {locationLabel(location, state)}
          </span>
        )}
      </div>
      {title !== groupTitle && <p className="site-final-report__issue-title">{title}</p>}
      <div className="site-final-report__description" data-copyable>
        {contrast ? (
          <>
            <dl className="site-final-report__contrast">
              <div><dt>측정한 글자</dt><dd>{contrast.text ? `“${contrast.text}”` : "글자 정보 없음"}</dd></div>
              <div><dt>명도 대비</dt><dd><strong>{contrast.contrast || "측정값 없음"}</strong></dd></div>
              <div><dt>기준</dt><dd>{contrast.required ? `${contrast.required} 이상` : "기준 정보 없음"}</dd></div>
            </dl>
            <div className="site-final-report__description-section">
              <p className="site-final-report__description-label">개선 안내</p>
              <p>글자와 배경의 명도 대비가 기준보다 낮아 저시력 사용자가 읽기 어렵습니다. 글자색이나 배경색을 바꿔 대비를 기준 이상으로 높여 주세요.</p>
            </div>
          </>
        ) : descriptionSections.map((section, index) => section.heading ? (
          <div key={index} className="site-final-report__description-section">
            <p className="site-final-report__description-label">{section.heading}</p>
            <p>{section.body}</p>
          </div>
        ) : <p key={index}>{section.body}</p>)}
      </div>
      {engineOriginal && (
        <details className="site-final-report__original">
          <summary>검사 엔진 원문 보기</summary>
          <p data-copyable>{engineOriginal}</p>
        </details>
      )}
      <dl className="site-final-report__code-location">
        {explanation && (
          <div>
            <dt>현재 위치</dt>
            <dd>
              <strong>{explanation.label}</strong>
              <span className="site-final-report__explanation">{explanation.description}</span>
            </dd>
          </div>
        )}
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
      {location && onShowOnPage && onShowDetails && <div className="site-final-report__issue-actions">
        {canShowOnPage(location) && (
          <button type="button" className="site-final-report__button site-final-report__button--primary"
            onClick={() => onShowOnPage(issue.id)}>
            <LocateFixed size={16} aria-hidden="true" />
            페이지에서 보기
            <span className="sr-only">: {title}</span>
          </button>
        )}
        <button type="button" className="site-final-report__button" onClick={() => onShowDetails(issue.id)}>
          <FileText size={16} aria-hidden="true" />
          문제 상세
          <span className="sr-only">: {title}</span>
        </button>
      </div>}
    </li>
  );
}
