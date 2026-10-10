import { useEffect, useId, useRef, useState } from "react";

/** 최종 리포트·개선 도구에 쓰는 점수 추이: 국세청 누리집 실제 분석 기록(2026-09-30 ~ 10-08). 한 축척으로 그리고 끝점을 강조한다. */
const SAMPLE_TREND = [
  { day: "9.30", time: "23:54", score: 61.2 },
  { day: "10.1", time: "00:05", score: 64.2 },
  { day: "10.1", time: "00:37", score: 61.4 },
  { day: "10.1", time: "03:42", score: 64.2 },
  { day: "10.8", time: "19:49", score: 64.8 }
] as const;
const SAMPLE_SCORES = SAMPLE_TREND.map(point => point.score);

type TrendProps = {
  className?: string;
  width: number;
  height: number;
  labels?: boolean;
};

export function LandingTrend({ className, width, height, labels = false }: TrendProps) {
  const pad = labels ? { l: 4, r: 4, t: 22, b: 18 } : { l: 4, r: 6, t: 8, b: 6 };
  const lo = 58;
  const hi = 68;
  const last = SAMPLE_SCORES.length - 1;
  const x = (i: number) => pad.l + (i * (width - pad.l - pad.r)) / last;
  const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * (height - pad.t - pad.b);
  const points = SAMPLE_SCORES.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M${x(0)},${height - pad.b} L${points.join(" L")} L${x(last)},${height - pad.b} Z`;
  const first = SAMPLE_SCORES[0];
  const end = SAMPLE_SCORES[last];

  return (
    <svg className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio={labels ? undefined : "none"}
      role="img" aria-label={`최근 ${SAMPLE_SCORES.length}회 점수: ${SAMPLE_SCORES.join(", ")}`}>
      <path d={area} className="ua-trend__area" />
      <polyline points={points.join(" ")} className="ua-trend__line" vectorEffect="non-scaling-stroke" />
      <circle cx={x(last)} cy={y(end)} r="4" className="ua-trend__dot" />
      {labels ? (
        <>
          <text x={x(0)} y={y(first) - 8} textAnchor="start">{first}</text>
          <text x={x(last)} y={y(end) - 10} textAnchor="end" className="ua-trend__end">{end}점</text>
          <text x={x(0)} y={height - 2} textAnchor="start">9월 30일</text>
          <text x={x(last)} y={height - 2} textAnchor="end">10월 8일</text>
        </>
      ) : null}
    </svg>
  );
}

// 실제 리포트 점수 추이(report-score-trend.tsx, Recharts)와 같은 치수: 0~100 축, 위 24·좌우 20 여백, 아래 36은 날짜·시간 두 줄.
// 랜딩 번들은 차트 라이브러리를 쓸 수 없어 같은 모양을 직접 그린다. 두 그림을 함께 고칠 것.
const REPORT_TREND = { width: 668, height: 176, top: 24, side: 20, axis: 36 };

/** 단조 3차 곡선(d3 curveMonotoneX, Recharts type="monotone"과 같은 곡선). */
function monotonePath(points: ReadonlyArray<readonly [number, number]>): string {
  const n = points.length;
  const secant = points.slice(0, -1).map(([x0, y0], i) => (points[i + 1]![1] - y0) / (points[i + 1]![0] - x0));
  const tangent = points.map((_, i) => {
    if (i === 0 || i === n - 1) return Number.NaN;
    const h0 = points[i]![0] - points[i - 1]![0];
    const h1 = points[i + 1]![0] - points[i]![0];
    const s0 = secant[i - 1]!;
    const s1 = secant[i]!;
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  });
  if (n > 2) {
    tangent[0] = (3 * secant[0]! - tangent[1]!) / 2;
    tangent[n - 1] = (3 * secant[n - 2]! - tangent[n - 2]!) / 2;
  } else {
    tangent[0] = tangent[n - 1] = secant[0] ?? 0;
  }
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const third = (x1 - x0) / 3;
    d += ` C${x0 + third},${y0 + third * tangent[i]!} ${x1 - third},${y1 - third * tangent[i + 1]!} ${x1},${y1}`;
  }
  return d;
}

/**
 * 최종 리포트 점수 타일의 추이 그림: 모든 점에 날짜(위)와 시간(아래), 지금 분석에만 점수와 점.
 * 실제 리포트(ResponsiveContainer)처럼 그려진 폭으로 다시 그려, 좁은 화면에서도 글자가 12px로 남는다.
 */
export function LandingReportTrend() {
  const fillId = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState<number>(REPORT_TREND.width);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { height, top, side, axis } = REPORT_TREND;
  const bottom = height - axis;
  const last = SAMPLE_TREND.length - 1;
  const x = (i: number) => side + (i * (width - side * 2)) / last;
  const y = (score: number) => top + (1 - score / 100) * (bottom - top);
  const points = SAMPLE_TREND.map((point, i) => [x(i), y(point.score)] as const);
  const line = monotonePath(points);
  const [endX, endY] = points[last]!;

  return (
    <svg ref={ref} className="ua-report__trend" viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`최근 ${SAMPLE_TREND.length}회 점수: ${SAMPLE_TREND.map(point => `${point.day} ${point.time} ${point.score}점`).join(", ")}`}>
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ua-report-blue)" stopOpacity={0.18} />
          <stop offset="100%" stopColor="var(--ua-report-blue)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${endX},${bottom} L${points[0]![0]},${bottom} Z`} fill={`url(#${fillId})`} />
      <path d={line} fill="none" stroke="var(--ua-report-blue)" strokeWidth={2.5} />
      <circle className="ua-report__trend-pulse" cx={endX} cy={endY} r={2.5} fill="none" stroke="var(--ua-report-blue)" strokeWidth={1.5} />
      <circle cx={endX} cy={endY} r={2.5} fill="var(--ua-report-blue)" />
      <text x={endX} y={endY - 10} textAnchor="middle" className="ua-report__trend-label">{SAMPLE_TREND[last].score}</text>
      {SAMPLE_TREND.map((point, i) => (
        <text key={i} x={x(i)} y={bottom + 8} textAnchor="middle" className="ua-report__trend-tick">
          <tspan x={x(i)} dy="0.71em" className="ua-report__trend-day">{point.day}</tspan>
          <tspan x={x(i)} dy="1.25em">{point.time}</tspan>
        </text>
      ))}
    </svg>
  );
}
