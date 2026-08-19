import { ChartContainer, ChartTooltip } from "@/components/ui/line-charts-6";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";

import { chartConfig, chartLineVisibility, scoreGridLines } from "./constants";
import { SummaryStatCards } from "./summary-stat-cards";
import type { ChartSeriesKey, ScoreChartItem, SiteSummaryItem } from "./types";
import { formatDateLabel, getChartLabel, getChartValueSuffix } from "./utils";

type ScoreTrendCardProps = {
  chartData: ScoreChartItem[];
  summaryItems: SiteSummaryItem[];
};

type IssueBarShapeProps = {
  fill?: string;
  height?: number | string;
  width?: number | string;
  x?: number | string;
  y?: number | string;
};

type ScoreDotProps = {
  cx?: number | string;
  cy?: number | string;
  payload?: ScoreChartItem;
  active?: boolean;
};

function toChartNumber(value: number | string | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function IssueBarShape({ fill, height, width, x, y }: IssueBarShapeProps) {
  const xValue = toChartNumber(x);
  const yValue = toChartNumber(y);
  const widthValue = toChartNumber(width);
  const heightValue = toChartNumber(height);

  if (widthValue <= 0 || heightValue <= 0) {
    return null;
  }

  const radius = Math.min(3, widthValue / 2, heightValue);
  const right = xValue + widthValue;
  const bottom = yValue + heightValue;
  const barPath = [
    `M ${xValue} ${bottom}`,
    `V ${yValue + radius}`,
    `Q ${xValue} ${yValue} ${xValue + radius} ${yValue}`,
    `H ${right - radius}`,
    `Q ${right} ${yValue} ${right} ${yValue + radius}`,
    `V ${bottom}`,
    "Z"
  ].join(" ");

  return (
    <g>
      <rect
        x={xValue - 1}
        y={yValue - 1}
        width={widthValue + 2}
        height={heightValue + 2}
        fill="var(--dashboard-card-bg)"
      />
      <path d={barPath} fill={fill ?? "var(--site-issue-bar-color)"} />
    </g>
  );
}

function ScoreDateDot({ active = false, cx, cy, payload }: ScoreDotProps) {
  if (!payload) {
    return null;
  }

  return (
    <circle
      cx={toChartNumber(cx)}
      cy={toChartNumber(cy)}
      r={active ? 5 : 3}
      fill={chartConfig.score.color}
      stroke={chartConfig.score.color}
      strokeWidth={0}
    />
  );
}

function ActiveScoreDot(props: ScoreDotProps) {
  return <ScoreDateDot {...props} active />;
}

export function ScoreTrendCard({ chartData, summaryItems }: ScoreTrendCardProps) {
  const evaluatedPoints = chartData.filter((item) => item.date.length > 0);
  const latestPoint = evaluatedPoints[evaluatedPoints.length - 1];
  const chartSummary =
    latestPoint === undefined
      ? "아직 평가 기록이 없어 점수 추이를 표시할 수 없습니다."
      : `평가 ${evaluatedPoints.length}회 기준. 최근 평가일 ${formatDateLabel(latestPoint.date)}, 점수 ${latestPoint.score}점, 문제 ${latestPoint.issueCount}건.`;

  return (
    <article
      aria-labelledby="site-score-trend-heading"
      className="dashboard-card site-score-trend-card flex h-full min-h-0 w-full flex-col rounded-[18px] border-0 p-1"
    >
      <div className="site-dashboard-card-heading relative flex flex-wrap items-center justify-between gap-3 px-3 pt-3">
        <h2 id="site-score-trend-heading" className="text-[15px] font-bold text-[var(--dashboard-text-strong)]">
          접근성 점수 추이
        </h2>
        <ul className="site-score-legend flex flex-wrap items-center gap-3 text-xs font-semibold text-[var(--dashboard-text-muted)]">
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-0.5 w-4 rounded-full"
              style={{ backgroundColor: "var(--site-score-line-color)" }}
            />
            점수(선)
          </li>
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-3 w-2 rounded-sm"
              style={{ backgroundColor: "var(--site-issue-bar-color)" }}
            />
            문제 수(막대)
          </li>
        </ul>
      </div>
      <div className="site-score-chart-wrap mt-2 px-2.5 py-4">
        <p className="sr-only">{chartSummary}</p>
        <ChartContainer
          config={chartConfig}
          className="site-score-chart-container h-[clamp(15rem,32vh,22.5rem)] w-full overflow-visible [&_.recharts-curve.recharts-tooltip-cursor]:stroke-initial"
        >
          <ComposedChart
            data={chartData}
            margin={{
              top: 20,
              right: 20,
              left: 5,
              bottom: 20
            }}
            style={{ overflow: "visible" }}
          >
            <XAxis
              dataKey="slot"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={(value: number | string) => chartData[toChartNumber(value)]?.label ?? ""}
              tickMargin={10}
              interval={0}
              minTickGap={0}
              padding={{ left: 2, right: 2 }}
            />

            <YAxis
              yAxisId="score"
              axisLine={false}
              tickLine={false}
              domain={[0, 100]}
              ticks={[0, 20, 40, 60, 80, 100]}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={(value: number) => `${value}점`}
              tickMargin={10}
            />

            <YAxis
              yAxisId="issues"
              orientation="right"
              axisLine={false}
              tickLine={false}
              domain={[0, (dataMax: number) => Math.max(dataMax * 4, 1)]}
              width={0}
              tick={false}
              tickFormatter={() => ""}
            />

            <CartesianGrid
              yAxisId="score"
              vertical={false}
              horizontalValues={scoreGridLines}
              stroke="var(--site-score-grid-color)"
              strokeWidth={1}
              strokeOpacity={0.9}
            />

            <Bar
              yAxisId="issues"
              dataKey="issueCount"
              fill="var(--site-issue-bar-color)"
              fillOpacity={1}
              barSize={14}
              radius={[3, 3, 0, 0]}
              shape={<IssueBarShape />}
              isAnimationActive={false}
            />

            <ChartTooltip
              content={<ScoreTooltip visibleSeries={chartLineVisibility} />}
              cursor={{ strokeDasharray: "3 3", stroke: "var(--site-chart-cursor-color)" }}
            />

            <Line
              yAxisId="score"
              type="monotone"
              dataKey="score"
              stroke={chartConfig.score.color}
              strokeWidth={2.25}
              dot={false}
              activeDot={<ActiveScoreDot />}
            />
          </ComposedChart>
        </ChartContainer>
      </div>
      <div className="site-score-summary-wrap px-3 pb-3">
        <SummaryStatCards items={summaryItems} />
      </div>
    </article>
  );
}

function ScoreTooltip({
  active,
  payload,
  visibleSeries
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number;
    color?: string;
    payload?: ScoreChartItem;
  }>;
  visibleSeries: Record<ChartSeriesKey, boolean>;
}) {
  const rows = (payload ?? [])
    .filter(
      (entry): entry is { dataKey: string | number; value: number; color?: string; payload?: ScoreChartItem } =>
        typeof entry.value === "number" &&
        entry.dataKey !== undefined &&
        visibleSeries[String(entry.dataKey) as ChartSeriesKey] === true
    )
    .sort((left, right) => {
      const order: Record<ChartSeriesKey, number> = {
        score: 0,
        issueCount: 1
      };
      return order[String(left.dataKey) as ChartSeriesKey] - order[String(right.dataKey) as ChartSeriesKey];
    });

  const firstPayload = rows[0]?.payload;

  if (!active || rows.length === 0 || !firstPayload) {
    return null;
  }

  const hasEvaluationData = Boolean(firstPayload.date);
  const label = hasEvaluationData ? formatDateLabel(firstPayload.date) : "평가 기록 없음";
  const visibleRows = hasEvaluationData
    ? rows
    : rows.filter((entry) => String(entry.dataKey) === "score");

  return (
    <div
      role="tooltip"
      className="min-w-[170px] rounded-lg border-0 bg-[var(--site-glass-bg-opaque)] px-3 py-2 text-left shadow-[var(--site-glass-shadow)]"
    >
      {label && <p className="text-xs font-bold text-[var(--dashboard-text-strong)]">{label}</p>}
      <div className="mt-1 grid gap-1.5 text-sm">
        {visibleRows.map((entry) => {
          const key = String(entry.dataKey) as keyof typeof chartConfig;
          const swatchColor =
            key === "score" ? "var(--site-score-line-color)" : "var(--site-issue-bar-color)";
          return (
            <div key={String(entry.dataKey)} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span
                  className={key === "score" ? "h-0.5 w-3 rounded-full" : "h-2.5 w-1.5 rounded-sm"}
                  style={{ backgroundColor: swatchColor }}
                  aria-hidden="true"
                />
                <span className="text-xs font-semibold text-[var(--dashboard-text-muted)]">{getChartLabel(key)}</span>
              </div>
              <span className="text-sm font-bold text-[var(--dashboard-text-strong)]">
                {hasEvaluationData ? entry.value : "-"}
                {getChartValueSuffix(key)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
