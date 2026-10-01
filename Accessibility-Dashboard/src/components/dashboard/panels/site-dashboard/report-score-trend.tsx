import { Area, ComposedChart, LabelList, ResponsiveContainer, XAxis, YAxis } from "recharts";

import type { ScoreChartItem } from "./types";
import { formatDateLabel } from "./utils";

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The report's score history. Every point carries its score and date as
 * visible labels, so the values read without hover; the list below the chart
 * gives the same values to screen readers.
 */
export function ReportScoreTrend({ items, currentRequestId }: {
  items: ScoreChartItem[];
  currentRequestId: number | null;
}) {
  if (items.length < 2) {
    return (
      <p className="site-final-report__trend-empty">
        {items.length === 1 ? "첫 분석 결과입니다. 다시 분석하면 점수 변화를 보여 드립니다." : "점수 기록이 없습니다."}
      </p>
    );
  }

  return (
    <figure className="site-final-report__trend" aria-label={`최근 ${items.length}회 점수 추이`}>
      <div className="site-final-report__trend-chart" aria-hidden="true">
        <ResponsiveContainer minWidth={0} minHeight={0} initialDimension={{ width: 1, height: 1 }}>
          <ComposedChart data={items} margin={{ top: 24, right: 20, bottom: 0, left: 20 }}>
            <defs>
              <linearGradient id="site-report-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--site-score-line-color)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--site-score-line-color)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="label" axisLine={false} tickLine={false} interval={0} tickMargin={8}
              tick={{ fill: "var(--dashboard-text-muted)", fontSize: 12 }} />
            <YAxis hide domain={[0, 100]} />
            <Area type="monotone" dataKey="score" stroke="var(--site-score-line-color)" strokeWidth={2.5}
              fill="url(#site-report-trend-fill)" isAnimationActive={false}
              dot={(props: { cx?: number; cy?: number; index?: number }) => (
                <TrendDot key={props.index} cx={props.cx} cy={props.cy}
                  current={items[props.index ?? -1]?.requestId === currentRequestId} />
              )}
              activeDot={false}>
              <LabelList dataKey="score" position="top" offset={10} formatter={(value: unknown) => formatScore(Number(value))}
                className="site-final-report__trend-label" />
            </Area>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">
        <ol>
          {items.map((item) => (
            <li key={item.slot}>{formatDateLabel(item.date)} {formatScore(item.score)}점</li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

function TrendDot({ cx, cy, current }: { cx?: number; cy?: number; current: boolean }) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return (
    <circle cx={cx} cy={cy} r={current ? 5.5 : 3.5}
      fill={current ? "var(--site-score-line-color)" : "var(--site-glass-bg-opaque, #ffffff)"}
      stroke="var(--site-score-line-color)" strokeWidth={2} />
  );
}
