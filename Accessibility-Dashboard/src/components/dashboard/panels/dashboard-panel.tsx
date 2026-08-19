import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { CircleAlert, Compass, Info, MoveRight, Plus, RotateCcw, Search } from "lucide-react";

import type { DashboardViewModel, ScoreResult, SeverityLevel } from "@/types/accessibility-domain";

import { chartTokens, severityLabelMap } from "../shared/constants";
import { PanelMessage } from "../shared/display";
import { CurrentOpenIssuesCard } from "./dashboard/current-open-issues-card";
import {
  buildDonutSegments,
  buildIssueCategoryRows,
  buildOpenSeverityCounts,
  buildRequestIssueContext,
  buildSeverityBarRows,
  buildWcagViolationRows,
  createEmptySeverityCounts,
  severityKeys,
  severityTrendColors
} from "./dashboard/dashboard-panel-model";
import { DashboardLoadingState } from "./dashboard/dashboard-loading-state";
import { IssueRatioDonutCard } from "./dashboard/issue-ratio-donut-card";
import { MiniScoreTrendChart } from "./dashboard/mini-score-trend-chart";
import { MonthlyScoreTrendCard } from "./dashboard/monthly-score-trend-card";
import { RadarScoreMetricCard } from "./dashboard/radar-score-metric-card";
import { buildRecentScanRows, RecentScanJobsCard } from "./dashboard/recent-scan-jobs-card";
import { buildMonthlyScoreSummaries, buildTopIssueSummaries } from "../shared/score-utils";
import { buildRecentMonthKeys, formatDateOnly } from "../shared/utils";

const DONUT_CIRCUMFERENCE = 2 * Math.PI * 88;
const wcagPageTransitionVariants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? 14 : -14
  }),
  center: {
    opacity: 1,
    x: 0
  }
};

export function DashboardPanel({
  data,
  isLoading,
  errorMessage,
  isDarkMode,
  onSiteClick,
  onRetry,
  onCreateProject,
  onStartEvaluation
}: {
  data: DashboardViewModel | null;
  isLoading: boolean;
  errorMessage: string;
  isDarkMode: boolean;
  onSiteClick: (input: { projectId: number; siteId: number }) => void;
  onRetry?: () => void;
  onCreateProject?: () => void;
  onStartEvaluation?: () => void;
}) {
  const [isWcagInfoVisible, setIsWcagInfoVisible] = useState(false);
  const [reportSearchQuery, setReportSearchQuery] = useState("");
  const [reportSearchMode, setReportSearchMode] = useState<"project" | "site">("project");
  const [selectedReportProjectId, setSelectedReportProjectId] = useState<number | null>(null);
  const [selectedReportSiteId, setSelectedReportSiteId] = useState<number | null>(null);
  const [wcagViolationPage, setWcagViolationPage] = useState(0);
  const [wcagViolationDirection, setWcagViolationDirection] = useState(0);
  const reportSearchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setIsWcagInfoVisible(false);
    setWcagViolationPage(0);
    setWcagViolationDirection(0);
  }, []);

  useEffect(() => {
    if (!data) {
      return;
    }

    const selectedProjectExists =
      selectedReportProjectId === null || data.organizations.some((project) => project.id === selectedReportProjectId);
    const selectedSiteExists =
      selectedReportSiteId === null ||
      data.organizations.some((project) => project.evaluationTargets.some((site) => site.id === selectedReportSiteId));

    if (!selectedProjectExists) {
      setSelectedReportProjectId(null);
      setSelectedReportSiteId(null);
      setReportSearchMode("project");
      return;
    }

    if (!selectedSiteExists) {
      setSelectedReportSiteId(null);
    }
  }, [data, selectedReportProjectId, selectedReportSiteId]);

  if (isLoading) {
    return <DashboardLoadingState />;
  }

  if (errorMessage.length > 0) {
    return (
      <article
        role="alert"
        className="flex flex-col items-start gap-3 rounded-[28px] border border-rose-200 bg-rose-50 p-5 text-sm"
      >
        <p className="flex items-center gap-2 font-semibold text-rose-700">
          <CircleAlert className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
          대시보드 로드 실패
        </p>
        <p className="text-rose-600">{errorMessage}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            <RotateCcw size={13} strokeWidth={2.4} aria-hidden="true" />
            다시 시도
          </button>
        )}
      </article>
    );
  }

  if (!data) {
    return <PanelMessage label="대시보드 데이터가 없습니다." />;
  }

  const scoreByEvaluationRequestModelId = new Map(data.scoreResults.map((score) => [score.evaluationRequestId, score]));
  const topIssueSummaries = buildTopIssueSummaries(data.issueResults);
  const monthlyScoreSummaries = buildMonthlyScoreSummaries(data.scoreResults);
  const scanRows = buildRecentScanRows(data);

  const {
    currentIssueResults,
    currentResultRequestIds,
    hasMaterializedResultContext,
    requestIdByAnalysisResultId
  } = buildRequestIssueContext(data);
  const categoryRows = buildIssueCategoryRows(currentIssueResults);
  const donutSegments = buildDonutSegments(categoryRows, DONUT_CIRCUMFERENCE, chartTokens.donutPalette);

  const fallbackMonthlyLabels = buildRecentMonthKeys(6);
  const buildMonthWindow = (endMonth: string, monthCount: number) => {
    const [yearValue, monthValue] = endMonth.split("-").map((value) => Number(value));
    if (!Number.isInteger(yearValue) || !Number.isInteger(monthValue)) {
      return fallbackMonthlyLabels;
    }

    return Array.from({ length: monthCount }, (_, index) => {
      const date = new Date(yearValue, monthValue - monthCount + index, 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    });
  };
  const monthlyScoreRows = [...monthlyScoreSummaries]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);
  const monthlySeriesRaw = monthlyScoreRows.map((item) => item.averageScore);
  const monthlyLabels =
    monthlyScoreRows.length >= 2
      ? monthlyScoreRows.map((item) => item.month)
      : monthlyScoreRows.length === 1
        ? buildMonthWindow(monthlyScoreRows[0]!.month, 6)
        : fallbackMonthlyLabels;
  const monthlySeries =
    monthlyScoreRows.length >= 2
      ? monthlySeriesRaw
      : monthlyScoreRows.length === 1
        ? monthlyLabels.map(() => monthlyScoreRows[0]!.averageScore)
        : monthlyLabels.map(() => 0);
  const currentMonthlyScoreResultModel = monthlySeries[monthlySeries.length - 1] ?? 0;
  const monthlyTrendPoints = monthlyLabels.map((month, index) => ({
    month,
    score: monthlySeries[index] ?? 0
  }));
  const currentOpenSeverityCounts = buildOpenSeverityCounts({
    currentIssueResults,
    hasMaterializedResultContext,
    topIssueSummaries
  });
  const summaryByRequestId = new Map(data.resultSummaries.map((summary) => [summary.requestId, summary]));
  const currentResultSummaries = [...currentResultRequestIds]
    .map((requestId) => summaryByRequestId.get(requestId))
    .filter(
      (summary): summary is DashboardViewModel["resultSummaries"][number] => summary !== undefined
    );

  const currentSummaryIssueCount = currentResultSummaries.reduce(
    (sum, summary) => sum + summary.totalIssueCount,
    0
  );
  const currentSummaryCriticalIssueCount = currentResultSummaries.reduce(
    (sum, summary) => sum + summary.criticalIssueCount,
    0
  );

  if (currentIssueResults.length === 0 && currentSummaryIssueCount > 0) {
    currentOpenSeverityCounts.CRITICAL = currentSummaryCriticalIssueCount;
  }

  const issueResultOpenIssueCount = severityKeys.reduce((sum, severity) => sum + currentOpenSeverityCounts[severity], 0);
  const currentOpenIssueCount = currentSummaryIssueCount > 0 ? currentSummaryIssueCount : issueResultOpenIssueCount;
  const severityBarRows = buildSeverityBarRows(currentOpenSeverityCounts);
  const wcagViolationRows = buildWcagViolationRows({
    currentIssueResults,
    hasMaterializedResultContext,
    topIssueSummaries
  });
  const wcagViolationPages = wcagViolationRows.slice(0, 5);
  const activeWcagViolationPage = Math.min(wcagViolationPage, Math.max(wcagViolationPages.length - 1, 0));
  const activeWcagViolation = wcagViolationPages[activeWcagViolationPage] ?? null;
  const canMoveWcagViolationBackward = activeWcagViolationPage > 0;
  const canMoveWcagViolationForward = activeWcagViolationPage < wcagViolationPages.length - 1;
  const handleWcagViolationPageChange = (nextPage: number) => {
    if (nextPage === activeWcagViolationPage) {
      return;
    }

    setWcagViolationDirection(nextPage > activeWcagViolationPage ? 1 : -1);
    setWcagViolationPage(nextPage);
  };
  const reportSiteEntries = data.organizations.flatMap((project) =>
    project.evaluationTargets.map((site) => ({
      project,
      site
    }))
  );
  const selectedReportSiteEntry =
    selectedReportSiteId === null ? null : reportSiteEntries.find((entry) => entry.site.id === selectedReportSiteId) ?? null;
  const selectedReportProject =
    selectedReportProjectId === null
      ? selectedReportSiteEntry?.project ?? null
      : data.organizations.find((project) => project.id === selectedReportProjectId) ?? selectedReportSiteEntry?.project ?? null;
  const selectedReportSite = selectedReportSiteEntry?.site ?? null;
  const reportSearchFilterLabel = reportSearchMode === "project" ? "프로젝트" : "사이트";
  const reportSearchToggleLabel = reportSearchMode === "project" ? "사이트" : "프로젝트";
  const reportSearchPlaceholder = reportSearchMode === "project" ? "프로젝트 이름 검색..." : "사이트 이름 검색...";
  const normalizedReportSearchQuery = reportSearchQuery.trim().toLowerCase();

  type ReportSearchOption =
    | { kind: "project"; id: number; label: string; description: string }
    | { kind: "site"; id: number; projectId: number; label: string; description: string };

  const matchesReportSearchQuery = (values: string[]) =>
    normalizedReportSearchQuery.length > 0 &&
    values.some((value) => value.toLowerCase().includes(normalizedReportSearchQuery));

  const reportSearchOptions: ReportSearchOption[] =
    normalizedReportSearchQuery.length === 0
      ? []
      : reportSearchMode === "project"
        ? data.organizations
            .filter((project) => matchesReportSearchQuery([project.name]))
            .map((project) => ({
              kind: "project" as const,
              id: project.id,
              label: project.name,
              description: `${project.evaluationTargets.length}개 사이트`
            }))
            .slice(0, 6)
        : reportSiteEntries
            .filter((entry) => {
              if (selectedReportProject && entry.project.id !== selectedReportProject.id) {
                return false;
              }
              return matchesReportSearchQuery([entry.site.name]);
            })
            .map((entry) => ({
              kind: "site" as const,
              id: entry.site.id,
              projectId: entry.project.id,
              label: entry.site.name,
              description: entry.project.name
            }))
            .slice(0, 6);

  const handleSelectReportSearchOption = (option: ReportSearchOption) => {
    if (option.kind === "project") {
      setSelectedReportProjectId(option.id);
      setSelectedReportSiteId(null);
      setReportSearchMode("site");
    } else {
      setSelectedReportProjectId(option.projectId);
      setSelectedReportSiteId(option.id);
      setReportSearchMode("site");
    }

    setReportSearchQuery("");
  };

  const reportScopeSiteIds =
    selectedReportSite !== null
      ? new Set([selectedReportSite.id])
      : selectedReportProject !== null
        ? new Set(selectedReportProject.evaluationTargets.map((site) => site.id))
        : new Set<number>();
  const reportScopeRows =
    reportScopeSiteIds.size > 0 ? scanRows.filter((row) => reportScopeSiteIds.has(row.siteId)) : scanRows;
  const latestReportScanRow = reportScopeRows.find((row) => row.totalScore !== null) ?? reportScopeRows[0] ?? null;
  const scopedLatestReportRows =
    selectedReportProject !== null && selectedReportSite === null
      ? selectedReportProject.evaluationTargets
          .map((site) => reportScopeRows.find((row) => row.siteId === site.id && row.totalScore !== null) ?? reportScopeRows.find((row) => row.siteId === site.id))
          .filter((row): row is (typeof scanRows)[number] => Boolean(row))
      : latestReportScanRow
        ? [latestReportScanRow]
        : [];
  const latestReportRequestIds = new Set(scopedLatestReportRows.map((row) => row.id));
  const latestReportIssues =
    latestReportRequestIds.size > 0 && hasMaterializedResultContext
      ? (data.issueResults ?? []).filter((issue) => {
          const requestId = requestIdByAnalysisResultId.get(issue.analysisResultId);
          return typeof requestId === "number" && latestReportRequestIds.has(requestId);
        })
      : [];
  const latestReportScoredRows = scopedLatestReportRows.filter((row) => row.totalScore !== null);
  const latestReportScore =
    selectedReportProject !== null && selectedReportSite === null
      ? latestReportScoredRows.length > 0
        ? Math.round(
            latestReportScoredRows.reduce((sum, row) => sum + (row.totalScore ?? 0), 0) / latestReportScoredRows.length
          )
        : null
      : latestReportScanRow?.totalScore ?? null;
  const latestReportProjectTitle = selectedReportProject?.name ?? latestReportScanRow?.project ?? "리포트 대기";
  const latestReportSiteTitle =
    selectedReportSite?.name ??
    (selectedReportProject ? `${selectedReportProject.evaluationTargets.length}개 사이트 요약` : latestReportScanRow?.site ?? "최근 평가 없음");
  const isProjectReportSummary = selectedReportProject !== null && selectedReportSite === null;
  const latestReportDate = reportScopeRows[0]?.updatedAt ?? latestReportScanRow?.updatedAt ?? null;
  const latestReportDirectSiteTarget = selectedReportSiteEntry
    ? {
        projectId: selectedReportSiteEntry.project.id,
        siteId: selectedReportSiteEntry.site.id
      }
    : latestReportScanRow && latestReportScanRow.projectId !== null
      ? {
          projectId: latestReportScanRow.projectId,
          siteId: latestReportScanRow.siteId
        }
      : null;
  const latestReportSeverityCounts = createEmptySeverityCounts();
  const addLatestReportFinding = (input: {
    count: number;
    severity: SeverityLevel;
  }) => {
    latestReportSeverityCounts[input.severity] += input.count;
  };

  if (latestReportRequestIds.size > 0 && hasMaterializedResultContext) {
    for (const issue of latestReportIssues) {
      addLatestReportFinding({
        count: 1,
        severity: issue.severity
      });
    }
  } else if (latestReportScanRow) {
    for (const issue of topIssueSummaries) {
      addLatestReportFinding({
        count: issue.count,
        severity: issue.severity
      });
    }
  }

  const latestReportIssueCount = severityKeys.reduce((sum, severity) => sum + latestReportSeverityCounts[severity], 0);
  const latestReportMaxSeverityCount = Math.max(1, ...severityKeys.map((severity) => latestReportSeverityCounts[severity]));
  const latestReportSeverityBars = severityKeys.map((severity) => ({
    severity,
    label: severityLabelMap[severity],
    count: latestReportSeverityCounts[severity],
    color: severityTrendColors[severity],
    heightPercentage:
      latestReportSeverityCounts[severity] > 0
        ? Math.max((latestReportSeverityCounts[severity] / latestReportMaxSeverityCount) * 100, 12)
        : 0
  }));
  const latestReportScoreHistory =
    reportScopeSiteIds.size > 0
      ? [...data.evaluationRequests]
          .filter((request) => reportScopeSiteIds.has(request.evaluationTargetId))
          .map((request) => ({
            score: scoreByEvaluationRequestModelId.get(request.id)?.totalScore ?? null,
            time: Date.parse(request.updatedAt)
          }))
          .filter((row): row is { score: number; time: number } => row.score !== null && !Number.isNaN(row.time))
          .sort((a, b) => a.time - b.time)
          .slice(-6)
      : latestReportScanRow
        ? [...data.evaluationRequests]
            .filter((request) => request.evaluationTargetId === latestReportScanRow.siteId)
            .map((request) => ({
              score: scoreByEvaluationRequestModelId.get(request.id)?.totalScore ?? null,
              time: Date.parse(request.updatedAt)
            }))
            .filter((row): row is { score: number; time: number } => row.score !== null && !Number.isNaN(row.time))
            .sort((a, b) => a.time - b.time)
            .slice(-6)
        : [];
  const latestReportScoreTrendSeries =
    latestReportScoreHistory.length >= 2
      ? latestReportScoreHistory.map((row) => row.score)
      : latestReportScore !== null
        ? Array.from({ length: 6 }, () => latestReportScore)
        : monthlySeries.slice(-6);
  const currentScoreResultModelValueColor = isDarkMode ? "#ffffff" : "#0f172a";
  const currentScoreResultModelUnitColor = isDarkMode ? "#cbd5e1" : "#64748b";
  const currentScoreResultModelLabelColor = isDarkMode ? "#94a3b8" : "#64748b";
  const getAverageScore = (selector: (scoreResult: ScoreResult) => number) =>
    data.scoreResults.length > 0
      ? Math.round(data.scoreResults.reduce((sum, scoreResult) => sum + selector(scoreResult), 0) / data.scoreResults.length)
      : 0;
  const radarRows = [
    {
      key: "cv",
      label: "시각",
      value: getAverageScore((scoreResult) => scoreResult.cvScore)
    },
    {
      key: "rule_based",
      label: "규칙",
      value: getAverageScore((scoreResult) => scoreResult.ruleScore)
    },
    {
      key: "difficulty",
      label: "텍스트",
      value: getAverageScore((scoreResult) => scoreResult.aiScore)
    }
  ];
  const shouldShowOnboarding = data.evaluationRequests.length === 0;

  return (
    <div className="space-y-3">
      {shouldShowOnboarding && (
        <article className="flex flex-col gap-3 rounded-[28px] border border-[#ef6a50]/25 bg-gradient-to-r from-[#ef6a50]/[0.07] to-transparent p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-[#ef6a50]/12 text-[#ef6a50]"
            >
              <Compass size={18} strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-900">아직 평가 결과가 없습니다</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                URL 하나로 바로 접근성 평가를 시작하거나, 프로젝트를 만들어 사이트별로 관리할 수 있습니다.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {onStartEvaluation && (
              <button
                type="button"
                onClick={onStartEvaluation}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#ef6a50] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#e85d43] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ef6a50]/30"
              >
                <Search size={13} strokeWidth={2.4} aria-hidden="true" />
                URL 바로 평가하기
              </button>
            )}
            {onCreateProject && (
              <button
                type="button"
                onClick={onCreateProject}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 transition hover:border-slate-400 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
              >
                <Plus size={13} strokeWidth={2.4} aria-hidden="true" />
                프로젝트 추가
              </button>
            )}
          </div>
        </article>
      )}
      <>
          <div className="grid overflow-visible gap-3 xl:grid-cols-[minmax(0,1fr)_420px] 2xl:grid-cols-[minmax(0,1fr)_460px]">
            <div className="grid min-w-0 overflow-visible gap-3 xl:grid-cols-[minmax(220px,0.8fr)_minmax(220px,0.8fr)_minmax(280px,1.4fr)] xl:grid-rows-[280px_348px] 2xl:grid-cols-[minmax(240px,0.78fr)_minmax(240px,0.78fr)_minmax(320px,1.44fr)]">
            <MonthlyScoreTrendCard
              currentScore={currentMonthlyScoreResultModel}
              isDarkMode={isDarkMode}
              points={monthlyTrendPoints}
            />
            <div className="order-2 grid h-[280px] min-h-0 gap-3 lg:grid-cols-2 xl:col-span-2 xl:col-start-2 xl:row-start-1">
            <CurrentOpenIssuesCard
              issueCount={currentOpenIssueCount}
              rows={severityBarRows}
              labelColor={currentScoreResultModelLabelColor}
              valueColor={currentScoreResultModelValueColor}
              unitColor={currentScoreResultModelUnitColor}
            />

            <article className="dashboard-card relative flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-1">
              <div className="flex min-h-[30px] items-start justify-between gap-3 px-4 pt-3">
                <div className="min-w-0">
                  <div className="relative flex items-center gap-1">
                    <p className="text-sm font-semibold leading-5 text-slate-900">반복 이슈 유형</p>
                    <button
                      type="button"
                      className="inline-flex h-5 w-5 shrink-0 translate-y-[1px] items-center justify-center rounded-full text-slate-500 transition-colors hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                      aria-label="반복 이슈 유형 설명"
                      onMouseEnter={() => setIsWcagInfoVisible(true)}
                      onMouseLeave={() => setIsWcagInfoVisible(false)}
                      onFocus={() => setIsWcagInfoVisible(true)}
                      onBlur={() => setIsWcagInfoVisible(false)}
                    >
                      <Info size={15} strokeWidth={1.9} />
                    </button>
                    {isWcagInfoVisible && (
                      <div
                        className="pointer-events-none absolute left-3 top-8 z-[130] w-64 rounded-lg bg-slate-950 px-3 py-2 text-left text-[11px] font-medium leading-relaxed text-white shadow-[0_14px_32px_rgba(2,6,23,0.28)]"
                        role="tooltip"
                      >
                        이슈 코드별 미해결 건수를 발생 건수가 많은 순서로 보여줍니다.
                      </div>
                    )}
                  </div>
                </div>
                {wcagViolationPages.length > 1 && (
                  <nav className="flex shrink-0 items-center gap-1" aria-label="반복 이슈 유형 이동">
                    <button
                      type="button"
                      aria-label="이전 반복 이슈 유형"
                      disabled={!canMoveWcagViolationBackward}
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-full bg-transparent transition disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 ${
                        isDarkMode
                          ? "text-slate-500 hover:bg-white/10 hover:text-slate-100 focus-visible:bg-white/10 focus-visible:ring-white/15"
                          : "text-slate-600 hover:bg-slate-200/80 focus-visible:bg-slate-200/80 focus-visible:ring-slate-300"
                      }`}
                      onClick={() => handleWcagViolationPageChange(activeWcagViolationPage - 1)}
                    >
                      <svg width="28" height="28" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path
                          d="M22.499 12.85a.9.9 0 0 1 .57.205l.067.06a.9.9 0 0 1 .06 1.206l-.06.066-5.585 5.586-.028.027.028.027 5.585 5.587a.9.9 0 0 1 .06 1.207l-.06.066a.9.9 0 0 1-1.207.06l-.066-.06-6.25-6.25a1 1 0 0 1-.158-.212l-.038-.08a.9.9 0 0 1-.03-.606l.03-.083a1 1 0 0 1 .137-.226l.06-.066 6.25-6.25a.9.9 0 0 1 .635-.263Z"
                          fill="currentColor"
                          stroke="currentColor"
                          strokeWidth=".078"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-label="다음 반복 이슈 유형"
                      disabled={!canMoveWcagViolationForward}
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-full bg-transparent transition disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 ${
                        isDarkMode
                          ? "text-slate-500 hover:bg-white/10 hover:text-slate-100 focus-visible:bg-white/10 focus-visible:ring-white/15"
                          : "text-slate-600 hover:bg-slate-200/80 focus-visible:bg-slate-200/80 focus-visible:ring-slate-300"
                      }`}
                      onClick={() => handleWcagViolationPageChange(activeWcagViolationPage + 1)}
                    >
                      <svg className="rotate-180" width="28" height="28" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <path
                          d="M22.499 12.85a.9.9 0 0 1 .57.205l.067.06a.9.9 0 0 1 .06 1.206l-.06.066-5.585 5.586-.028.027.028.027 5.585 5.587a.9.9 0 0 1 .06 1.207l-.06.066a.9.9 0 0 1-1.207.06l-.066-.06-6.25-6.25a1 1 0 0 1-.158-.212l-.038-.08a.9.9 0 0 1-.03-.606l.03-.083a1 1 0 0 1 .137-.226l.06-.066 6.25-6.25a.9.9 0 0 1 .635-.263Z"
                          fill="currentColor"
                          stroke="currentColor"
                          strokeWidth=".078"
                        />
                      </svg>
                    </button>
                  </nav>
                )}
              </div>

              {activeWcagViolation ? (
                <div className="relative mt-2 flex min-h-0 flex-1 flex-col">
                  <motion.div
                    key={activeWcagViolation.issueCode}
                    custom={wcagViolationDirection}
                    variants={wcagPageTransitionVariants}
                    initial="enter"
                    animate="center"
                    transition={{ duration: 0.24, ease: "easeOut" }}
                    className="flex min-h-0 flex-1 flex-col rounded-[28px] bg-white pt-3"
                  >
                    <div className="flex h-full flex-col px-5">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold tracking-[0.08em]" style={{ color: "#64748b" }}>
                          {activeWcagViolation.kwcagLabel}
                        </p>
                        <p className="mt-1 text-[1.75rem] font-bold leading-none text-slate-900">
                          {activeWcagViolation.count}
                          <span className="ml-1 text-xl font-semibold tracking-normal" style={{ color: currentScoreResultModelUnitColor }}>
                            건
                          </span>
                        </p>
                      </div>
                      <div className="mt-auto min-w-0 translate-y-[-24px]">
                        <p
                          className="line-clamp-1 text-[1.42rem] font-bold leading-tight text-slate-900"
                          title={activeWcagViolation.label}
                        >
                          {activeWcagViolation.label}
                        </p>
                        <p className="mt-2 line-clamp-2 text-[17px] font-medium leading-relaxed" style={{ color: "#64748b" }}>
                          {activeWcagViolation.description}
                        </p>
                      </div>
                    </div>
                  </motion.div>

                </div>
              ) : (
                <div className="mt-2 flex min-h-0 flex-1 items-center justify-center rounded-[28px] bg-white p-2 text-sm font-semibold text-slate-500">
                  표시할 반복 이슈 유형이 없습니다.
                </div>
              )}
            </article>
            </div>

              <RadarScoreMetricCard isDarkMode={isDarkMode} rows={radarRows} />

              <article className="dashboard-card order-5 flex h-[348px] min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-1 xl:col-span-1 xl:col-start-3 xl:row-start-2">
                <div className="min-h-[36px] px-3 pt-3">
                  <p className="text-sm font-semibold text-slate-900">접근성 평가 리포트 요약</p>
                </div>
                <div className="mx-auto mt-6 grid w-[90%] max-w-[620px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 sm:gap-3">
                  <div className="relative flex min-w-0 max-w-[440px] items-center gap-2">
                    <button
                      type="button"
                      aria-label="리포트 검색"
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-200"
                      onClick={() => reportSearchInputRef.current?.focus()}
                    >
                      <Search aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
                    </button>
                    <div className="flex h-9 min-w-0 flex-1 items-center rounded-xl bg-white px-2">
                      <span className="inline-flex h-7 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 text-[11px] font-bold text-slate-700">
                        {reportSearchFilterLabel}
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#ef6a50]" />
                      </span>
                      <input
                        ref={reportSearchInputRef}
                        type="search"
                        aria-label={`${reportSearchFilterLabel} 검색`}
                        value={reportSearchQuery}
                        onChange={(event) => setReportSearchQuery(event.target.value)}
                        placeholder={reportSearchPlaceholder}
                        className="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-sm font-medium text-slate-700 outline-none placeholder:text-slate-400 focus:ring-0"
                      />
                    </div>
                    {normalizedReportSearchQuery.length > 0 && (
                      <div className="report-search-popover absolute left-0 top-11 z-[140] w-full overflow-hidden rounded-xl border border-slate-200 text-left shadow-[0_14px_30px_rgba(15,23,42,0.08)]">
                        {reportSearchOptions.length > 0 ? (
                          reportSearchOptions.map((option) => (
                            <button
                              key={`${option.kind}-${option.id}`}
                              type="button"
                              className="report-search-option block w-full px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-200"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                handleSelectReportSearchOption(option);
                              }}
                              onClick={() => handleSelectReportSearchOption(option)}
                            >
                              <span className="report-search-option-title block truncate text-xs font-bold">{option.label}</span>
                              <span className="report-search-option-description mt-0.5 block truncate text-[11px] font-medium">
                                {option.description}
                              </span>
                            </button>
                          ))
                        ) : (
                          <p className="px-3 py-2 text-xs font-medium" style={{ color: "#64748b" }}>
                            검색 결과가 없습니다.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={`${reportSearchToggleLabel} 검색으로 변경`}
                    onClick={() => {
                      setReportSearchMode((current) => (current === "project" ? "site" : "project"));
                      setReportSearchQuery("");
                      reportSearchInputRef.current?.focus();
                    }}
                    className="inline-flex h-8 shrink-0 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-200"
                  >
                    {reportSearchToggleLabel}
                  </button>
                  <button
                    type="button"
                    aria-label="현재 리포트 사이트로 들어가기"
                    disabled={!latestReportDirectSiteTarget}
                    onClick={() => {
                      if (!latestReportDirectSiteTarget) {
                        return;
                      }
                      onSiteClick(latestReportDirectSiteTarget);
                    }}
                    className="inline-flex h-8 w-14 shrink-0 items-center justify-center rounded-full bg-[#ef6a50] text-white disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ef6a50]/35"
                  >
                    <MoveRight aria-hidden="true" className="h-5 w-7" strokeWidth={2.1} />
                  </button>
                </div>
                <div className="mx-auto mt-auto mb-6 grid h-[198px] min-h-0 w-[90%] max-w-[620px] grid-cols-3 gap-4">
                  <div className="relative flex min-w-0 flex-col overflow-hidden rounded-[28px] bg-white p-4">
                    <div className="min-w-0">
                      {!isProjectReportSummary && (
                        <p className="truncate text-xs font-semibold" style={{ color: "#64748b" }} title={latestReportProjectTitle}>
                          {latestReportProjectTitle}
                        </p>
                      )}
                      <p
                        className={`${isProjectReportSummary ? "mt-0" : "mt-2"} line-clamp-2 text-[1.25rem] font-bold leading-tight tracking-[-0.02em] text-slate-900`}
                        title={isProjectReportSummary ? latestReportProjectTitle : latestReportSiteTitle}
                      >
                        {isProjectReportSummary ? latestReportProjectTitle : latestReportSiteTitle}
                      </p>
                      <span className="mt-4 block h-1.5 w-14 rounded-full bg-[#ef6a50]" />
                    </div>
                    <div className="mt-auto min-w-0">
                      <p className="text-[10px] font-semibold" style={{ color: "#64748b" }}>평가일</p>
                      <p className="mt-1 truncate text-xs font-bold text-slate-900">
                        {formatDateOnly(latestReportDate)}
                      </p>
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-col overflow-hidden rounded-[28px] bg-white">
                    <div className="relative z-10 px-4 pt-4">
                      <p className="text-[11px] font-semibold" style={{ color: "#64748b" }}>현재 점수</p>
                      <p className="-ml-0.5 mt-0.5 text-[2.2rem] font-bold leading-none tracking-[-0.05em] text-slate-900">
                        {latestReportScore ?? "-"}
                        {latestReportScore !== null && (
                          <span className="ml-1 text-lg font-semibold tracking-normal" style={{ color: "#64748b" }}>점</span>
                        )}
                      </p>
                    </div>

                    <div className="relative mt-auto h-[116px] min-w-0 overflow-hidden">
                      <MiniScoreTrendChart
                        ariaLabel={`Recent accessibility score trend. Current ${latestReportScore ?? 0} points`}
                        isDarkMode={isDarkMode}
                        series={latestReportScoreTrendSeries}
                      />
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-col overflow-hidden rounded-[28px] bg-white p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold" style={{ color: "#64748b" }}>심각도별 문제</p>
                      <p className="shrink-0 text-sm font-bold text-slate-900">
                        {latestReportIssueCount}
                        <span className="ml-0.5 text-[11px] font-semibold" style={{ color: "#64748b" }}>건</span>
                      </p>
                    </div>

                    <div className="mt-auto h-[122px]">
                      <div className="relative h-[78px] border-b border-slate-200/70">
                        <div className="grid h-full grid-cols-4 items-end gap-3 pb-0">
                          {latestReportSeverityBars.map((bar) => (
                            <div key={bar.severity} className="flex h-full min-w-0 items-end justify-center">
                              <motion.div
                                className="w-5 rounded-md"
                                style={{ backgroundColor: bar.color }}
                                initial={{ height: 0 }}
                                animate={{ height: `${bar.heightPercentage}%` }}
                                transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-3 pt-3 text-center">
                        {latestReportSeverityBars.map((bar) => (
                          <div key={`${bar.severity}-label`} className="min-w-0">
                            <p className="text-xs font-bold leading-none text-slate-900">
                              {bar.count}
                            </p>
                            <p className="mt-1 truncate text-[9px] font-semibold" style={{ color: "#64748b" }}>
                              {bar.label}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </article>

              <IssueRatioDonutCard isDarkMode={isDarkMode} segments={donutSegments} />
            </div>

            <RecentScanJobsCard rows={scanRows} onSiteClick={onSiteClick} />
          </div>
      </>
    </div>
  );
}
