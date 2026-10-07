import { Area, ComposedChart, LabelList, ResponsiveContainer, usePlotArea, XAxis, YAxis } from "recharts";

import { trendAxisLabels, type TrendAxisLabel } from "./score-trend";
import type { ScoreChartItem } from "./types";
import { formatDateLabel, formatShortTime } from "./utils";

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The report's score history. The current analysis keeps its score label;
 * the others appear while the pointer is over their date (and always in
 * print). The list below the chart gives every value to screen readers.
 */
// The paper slot's size (CSS px) beside the score on an A4 page. Recharts
// measures its container on screen and cannot re-measure before the page is
// printed, so print draws at this size and the stylesheet fits it in.
const PRINT_SIZE = { width: 460, height: 96 };

// A small dot marks each score without crowding its label.
const DOT_RADIUS = 2.5;

// Room under the plot for the time line and, below it, the date line.
const AXIS_HEIGHT = 36;

export function ReportScoreTrend({ items, currentRequestId, printing = false }: {
  items: ScoreChartItem[];
  currentRequestId: number | null;
  printing?: boolean;
}) {
  if (items.length < 2) {
    return (
      <p className="site-final-report__trend-empty">
        {items.length === 1 ? "첫 분석 결과입니다. 다시 분석하면 점수 변화를 보여 드립니다." : "점수 기록이 없습니다."}
      </p>
    );
  }

  const axisLabels = trendAxisLabels(items);

  return (
    <figure className="site-final-report__trend" aria-label={`최근 ${items.length}회 점수 추이`}>
      {/* Recharts draws its layers as focusable groups (tabindex="-1"); a press
          would focus one and outline it, so presses here never take focus. */}
      <div className="site-final-report__trend-chart" aria-hidden="true" onMouseDown={(event) => event.preventDefault()}>
        <ResponsiveContainer key={printing ? "print" : "screen"} minWidth={0} minHeight={0}
          initialDimension={printing ? PRINT_SIZE : { width: 1, height: 1 }}
          {...(printing ? { width: PRINT_SIZE.width, height: PRINT_SIZE.height } : {})}>
          {/* The chart is a picture (aria-hidden; the list below reads the values),
              so it takes no focus: a click must not draw a focus outline around it. */}
          <ComposedChart data={items} margin={{ top: 24, right: 20, bottom: 0, left: 20 }} accessibilityLayer={false}>
            <defs>
              <linearGradient id="site-report-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--site-score-line-color)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--site-score-line-color)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="slot" axisLine={false} tickLine={false} tickSize={0} interval={0} tickMargin={8} height={AXIS_HEIGHT}
              tick={(props: { x?: number | string; y?: number | string; index?: number }) => (
                <TrendTick key={props.index} x={Number(props.x)} y={Number(props.y)} label={axisLabels[props.index ?? -1]} />
              )} />
            <YAxis hide domain={[0, 100]} />
            <Area type="monotone" dataKey="score" stroke="var(--site-score-line-color)" strokeWidth={2.5}
              fill="url(#site-report-trend-fill)" isAnimationActive={false}
              dot={(props: { cx?: number; cy?: number; index?: number }) => (
                <TrendDot key={props.index} cx={props.cx} cy={props.cy}
                  current={items[props.index ?? -1]?.requestId === currentRequestId} />
              )}
              activeDot={false}>
              <LabelList dataKey="score" content={(props: { x?: number | string; y?: number | string; value?: unknown; index?: number }) => (
                <TrendLabel key={props.index} x={Number(props.x)} y={Number(props.y)} value={Number(props.value)}
                  pointCount={items.length} current={items[props.index ?? -1]?.requestId === currentRequestId} />
              )} />
            </Area>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">
        <ol>
          {items.map((item) => (
            <li key={item.slot}>{formatDateLabel(item.date)} {formatShortTime(item.date)} {formatScore(item.score)}점</li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

// Every label is drawn so print can show them all. Past scores stay hidden on
// screen until the pointer enters their column: a transparent band spanning
// half the gap to each neighbour, from the top margin down to the date.
// CSS :hover reveals the label, so no state can lag behind the pointer.
function TrendLabel({ x, y, value, pointCount, current }: {
  x: number;
  y: number;
  value: number;
  pointCount: number;
  current: boolean;
}) {
  const plot = usePlotArea();
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(value)) return null;
  const step = plot && pointCount > 1 ? plot.width / (pointCount - 1) : 0;
  return (
    <g className="site-final-report__trend-point">
      {plot && step > 0 && (
        <rect className="site-final-report__trend-hit" x={x - step / 2} y={0}
          width={step} height={plot.y + plot.height + AXIS_HEIGHT} fill="transparent" />
      )}
      {/* Same dot as the current point's marker (TrendDot), minus the pulse. */}
      {!current && (
        <circle className="site-final-report__trend-hover-dot" cx={x} cy={y} r={DOT_RADIUS}
          fill="var(--site-score-line-color)" />
      )}
      <text x={x} y={y - 10} textAnchor="middle"
        className={`site-final-report__trend-label${current ? "" : " site-final-report__trend-label--resting"}`}>
        {formatScore(value)}
      </text>
    </g>
  );
}

// Same-day re-analyses are common (analyse, fix, analyse again), so each
// point is labelled by its time, with the date beneath only where a day starts.
function TrendTick({ x, y, label }: { x: number; y: number; label?: TrendAxisLabel }) {
  if (!label || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return (
    <text x={x} y={y} textAnchor="middle" className="site-final-report__trend-tick">
      <tspan x={x} dy="0.71em">{label.time}</tspan>
      {label.day && <tspan x={x} dy="1.25em" className="site-final-report__trend-tick-day">{label.day}</tspan>}
    </text>
  );
}

// Only the analysis being viewed gets a marker; the other points read from
// their score labels alone. A ring pulses out from it to mark "you are here".
function TrendDot({ cx, cy, current }: { cx?: number; cy?: number; current: boolean }) {
  if (!current || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return (
    <g className="site-final-report__trend-current">
      <circle className="site-final-report__trend-pulse" cx={cx} cy={cy} r={DOT_RADIUS}
        fill="none" stroke="var(--site-score-line-color)" strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={DOT_RADIUS} fill="var(--site-score-line-color)" />
    </g>
  );
}
