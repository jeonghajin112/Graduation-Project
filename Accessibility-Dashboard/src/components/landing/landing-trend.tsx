/** 최종 리포트·개선 도구에 쓰는 점수 추이: 국세청 누리집 실제 분석 기록(2026-09-30 ~ 10-08). 한 축척으로 그리고 끝점을 강조한다. */
const SAMPLE_SCORES = [61.2, 64.2, 61.4, 64.2, 64.8] as const;

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
