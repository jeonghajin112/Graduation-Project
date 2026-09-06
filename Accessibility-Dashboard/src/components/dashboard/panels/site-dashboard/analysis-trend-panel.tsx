import { useMemo } from "react";
import { Area, ComposedChart, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip } from "@/components/ui/line-charts-6";
import type {
  EvaluationRequestModel,
  EvaluationResultSummary,
  ScoreResult
} from "@/types/accessibility-domain";

import { chartConfig } from "./constants";
import type { ScoreChartItem } from "./types";
import { formatDateLabel, formatShortDate } from "./utils";

type AnalysisTrendPanelProps = {
  evaluationRequests: EvaluationRequestModel[];
  evaluationTargetId: number;
  resultSummaries: EvaluationResultSummary[];
  scoreResults: ScoreResult[];
};

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const TREND_SLOT_COUNT = 7;

export function AnalysisTrendPanel({
  evaluationRequests,
  evaluationTargetId,
  resultSummaries,
  scoreResults
}: AnalysisTrendPanelProps) {
  const data = useMemo(() => {
    const scoreByRequestId = new Map(
      scoreResults.map((scoreResult) => [
        scoreResult.evaluationRequestId,
        scoreResult.totalScore
      ])
    );
    const summaryByRequestId = new Map(
      resultSummaries.map((summary) => [summary.requestId, summary])
    );

    const recentItems = evaluationRequests
      .filter((request) => request.evaluationTargetId === evaluationTargetId)
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
          issueCount: summary?.totalIssueCount ?? 0
        } satisfies ScoreChartItem;
      })
      .filter((item): item is ScoreChartItem => item !== null)
      .sort((left, right) => Date.parse(left.date) - Date.parse(right.date))
      .slice(-TREND_SLOT_COUNT);

    const emptySlotCount = TREND_SLOT_COUNT - recentItems.length;
    const emptySlots = Array.from({ length: emptySlotCount }, (_, slot) => ({
      slot,
      date: "",
      label: "",
      score: 0,
      issueCount: 0,
      isPlaceholder: true
    } satisfies ScoreChartItem));

    return [
      ...emptySlots,
      ...recentItems.map((item, index) => ({
        ...item,
        slot: emptySlotCount + index
      }))
    ];
  }, [evaluationRequests, evaluationTargetId, resultSummaries, scoreResults]);
  const completedCount = data.filter((item) => !item.isPlaceholder).length;
  const latest = completedCount > 0 ? data[data.length - 1] : null;
  const chartSummary = latest
    ? `최근 ${completedCount}회 분석 기준. 최신 점수 ${formatScore(latest.score)}점, 문제 ${latest.issueCount}건.`
    : "완료된 분석 기록이 없어 추이 차트를 표시할 수 없습니다.";

  return (
    <aside className="site-page-evidence-trend-panel" aria-labelledby="site-analysis-trend-heading">
      <div className="site-rail-card__heading">
        <h3 id="site-analysis-trend-heading">최근 분석 추이</h3>
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

      {data.length > 0 ? (
        <ChartContainer config={chartConfig} className="site-page-evidence-trend-chart">
          <ComposedChart
            data={data}
            margin={{ top: 10, right: 12, bottom: 0, left: 12 }}
            accessibilityLayer
          >
            <defs>
              <linearGradient id="site-trend-score-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--site-score-line-color)" stopOpacity={0.14} />
                <stop offset="100%" stopColor="var(--site-score-line-color)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="slot"
              hide
            />
            <YAxis
              yAxisId="score"
              hide
              domain={[-5, 100]}
            />
            {/* Score only. The issue count is still reported in the metrics row,
                the tooltip and the screen-reader summary, so dropping the bar
                series removes a duplicate reading rather than information. */}
            <Area
              yAxisId="score"
              type="monotone"
              dataKey="score"
              stroke="var(--site-score-line-color)"
              strokeWidth={2.25}
              fill="url(#site-trend-score-fill)"
              // Points appear on hover only: no dot is painted at rest, and
              // activeDot draws one under the cursor. Verified that the tooltip
              // and the active point still fire with dots disabled.
              dot={false}
              activeDot={<TrendActiveDot />}
              isAnimationActive={false}
            />
            <ChartTooltip cursor={false} content={<AnalysisTrendTooltip />} />
          </ComposedChart>
        </ChartContainer>
      ) : (
        <div className="site-page-evidence-trend-empty" role="status">
          완료된 분석 기록이 쌓이면 추이를 확인할 수 있어요.
        </div>
      )}

      {/* No legend: a single series needs no key, and the metrics row above
          already names the value. The sr-only summary keeps the non-visual
          description of what the chart plots. */}
    </aside>
  );
}

function AnalysisTrendTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: ScoreChartItem }>;
}) {
  const item = payload?.find((entry) => entry.payload)?.payload;
  if (!active || !item || item.isPlaceholder) return null;

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

function TrendActiveDot({ cx, cy, payload }: {
  cx?: number;
  cy?: number;
  payload?: ScoreChartItem;
}) {
  if (!payload || payload.isPlaceholder || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return null;
  }

  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill="var(--site-score-line-color)"
      stroke="var(--card, #ffffff)"
      strokeWidth={2}
    />
  );
}
