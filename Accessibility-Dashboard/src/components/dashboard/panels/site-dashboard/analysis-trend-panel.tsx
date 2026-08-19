import { useEffect, useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip } from "@/components/ui/line-charts-6";
import {
  fetchDashboardViewModel,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";

import { chartConfig } from "./constants";
import type { ScoreChartItem } from "./types";
import { formatDateLabel, formatShortDate } from "./utils";

type AnalysisTrendPanelProps = {
  requestId: number | null;
};

type TrendState = {
  data: ScoreChartItem[];
  errorMessage: string;
  requestId: number | null;
  status: "idle" | "loading" | "ready" | "error";
};

const EMPTY_STATE: TrendState = {
  data: [],
  errorMessage: "",
  requestId: null,
  status: "idle"
};

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function AnalysisTrendPanel({ requestId }: AnalysisTrendPanelProps) {
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<TrendState>(EMPTY_STATE);

  useEffect(() => {
    if (requestId === null) {
      setState(EMPTY_STATE);
      return;
    }

    const controller = new AbortController();
    setState({ data: [], errorMessage: "", requestId, status: "loading" });

    void fetchDashboardViewModel(controller.signal)
      .then((dashboard) => {
        if (controller.signal.aborted) {
          return;
        }

        const currentRequest = dashboard.evaluationRequests.find((request) => request.id === requestId);
        if (!currentRequest) {
          throw new Error("현재 분석 요청 정보를 찾지 못했습니다.");
        }

        const scoreByRequestId = new Map(
          dashboard.scoreResults.map((scoreResult) => [
            scoreResult.evaluationRequestId,
            scoreResult.totalScore
          ])
        );
        const summaryByRequestId = new Map(
          dashboard.resultSummaries.map((summary) => [summary.requestId, summary])
        );
        const issueCountByRequestId = new Map<number, number>();

        for (const issue of dashboard.evaluationIssues) {
          issueCountByRequestId.set(
            issue.requestId,
            (issueCountByRequestId.get(issue.requestId) ?? 0) + 1
          );
        }

        const data = dashboard.evaluationRequests
          .filter((request) => request.evaluationTargetId === currentRequest.evaluationTargetId)
          .map((request) => {
            const summary = summaryByRequestId.get(request.id);
            const score = summary?.totalScore ?? scoreByRequestId.get(request.id) ?? null;
            if (score === null || !Number.isFinite(score)) {
              return null;
            }

            const date = summary?.requestedAt ?? request.requestedAt ?? request.updatedAt;
            return {
              slot: 0,
              date,
              label: formatShortDate(date),
              score: Math.round(score * 10) / 10,
              issueCount: summary?.totalIssueCount ?? issueCountByRequestId.get(request.id) ?? 0
            } satisfies ScoreChartItem;
          })
          .filter((item): item is ScoreChartItem => item !== null)
          .sort((left, right) => Date.parse(left.date) - Date.parse(right.date))
          .slice(-6)
          .map((item, slot) => ({ ...item, slot }));

        setState({ data, errorMessage: "", requestId, status: "ready" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        setState({
          data: [],
          errorMessage: getApiErrorMessage(error, "분석 추이를 불러오지 못했습니다."),
          requestId,
          status: "error"
        });
      });

    return () => controller.abort();
  }, [requestId, retryRevision]);

  const visibleState = state.requestId === requestId ? state : {
    data: [],
    errorMessage: "",
    requestId,
    status: requestId === null ? "idle" as const : "loading" as const
  };
  const latest = visibleState.data[visibleState.data.length - 1] ?? null;
  const issueAxisMax = useMemo(
    () => Math.max(1, ...visibleState.data.map((item) => item.issueCount)),
    [visibleState.data]
  );
  const chartSummary = latest
    ? `최근 ${visibleState.data.length}회 분석 기준. 최신 점수 ${formatScore(latest.score)}점, 문제 ${latest.issueCount}건.`
    : "완료된 분석 기록이 없어 추이 차트를 표시할 수 없습니다.";

  return (
    <aside className="site-page-evidence-trend-panel" aria-labelledby="site-analysis-trend-heading">
      <div className="site-page-evidence-trend-heading">
        <h3 id="site-analysis-trend-heading">최근 분석 추이</h3>
        <p>최근 완료된 분석의 점수와 문제 수</p>
      </div>

      {latest ? (
        <div className="site-page-evidence-trend-metrics" aria-label="최근 분석 요약">
          <div>
            <span>최근 점수</span>
            <strong>{formatScore(latest.score)}</strong>
            <small>점</small>
          </div>
          <div>
            <span>문제 수</span>
            <strong>{latest.issueCount}</strong>
            <small>건</small>
          </div>
        </div>
      ) : null}

      <p className="sr-only">{chartSummary}</p>

      {visibleState.status === "loading" ? (
        <div className="site-page-evidence-trend-empty" role="status">분석 추이를 불러오는 중입니다.</div>
      ) : visibleState.status === "error" ? (
        <div className="site-page-evidence-trend-empty" role="alert">
          <span>{visibleState.errorMessage}</span>
          <button type="button" onClick={() => setRetryRevision((current) => current + 1)}>
            다시 시도
          </button>
        </div>
      ) : visibleState.data.length > 0 ? (
        <ChartContainer config={chartConfig} className="site-page-evidence-trend-chart">
          <ComposedChart
            data={visibleState.data}
            margin={{ top: 18, right: 4, bottom: 8, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid vertical={false} stroke="var(--site-score-grid-color)" strokeOpacity={0.8} />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "var(--dashboard-text-muted)" }}
              tickMargin={8}
              interval={0}
              minTickGap={0}
            />
            <YAxis
              yAxisId="score"
              axisLine={false}
              tickLine={false}
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              width={30}
              tick={{ fontSize: 10, fill: "var(--dashboard-text-muted)" }}
            />
            <YAxis
              yAxisId="issues"
              orientation="right"
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
              domain={[0, Math.ceil(issueAxisMax * 1.2)]}
              width={26}
              tick={{ fontSize: 10, fill: "var(--dashboard-text-muted)" }}
            />
            <Bar
              yAxisId="issues"
              dataKey="issueCount"
              fill="var(--site-issue-bar-color)"
              barSize={12}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
            <Line
              yAxisId="score"
              type="monotone"
              dataKey="score"
              stroke="var(--site-score-line-color)"
              strokeWidth={2.25}
              dot={{ r: 2.75, fill: "var(--site-score-line-color)", strokeWidth: 0 }}
              activeDot={{ r: 4, fill: "var(--site-score-line-color)", strokeWidth: 0 }}
              isAnimationActive={false}
            />
            <ChartTooltip content={<AnalysisTrendTooltip />} />
          </ComposedChart>
        </ChartContainer>
      ) : (
        <div className="site-page-evidence-trend-empty" role="status">
          완료된 분석 기록이 쌓이면 추이를 확인할 수 있어요.
        </div>
      )}

      <ul className="site-page-evidence-trend-legend" aria-label="차트 범례">
        <li><span className="site-page-evidence-trend-line-key" aria-hidden="true" />점수</li>
        <li><span className="site-page-evidence-trend-bar-key" aria-hidden="true" />문제 수</li>
      </ul>
    </aside>
  );
}

function AnalysisTrendTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: ScoreChartItem }>;
}) {
  const item = payload?.find((entry) => entry.payload)?.payload;
  if (!active || !item) return null;

  return (
    <div className="site-page-evidence-trend-tooltip" role="tooltip">
      <p>{formatDateLabel(item.date)}</p>
      <dl>
        <div><dt>점수</dt><dd>{formatScore(item.score)}점</dd></div>
        <div><dt>문제 수</dt><dd>{item.issueCount}건</dd></div>
      </dl>
    </div>
  );
}
