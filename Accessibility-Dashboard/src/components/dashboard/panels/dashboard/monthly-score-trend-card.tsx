import { Info } from "lucide-react";
import { useId, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";

import { chartTokens } from "../../shared/constants";

type MonthlyScoreTrendPoint = {
  month: string;
  score: number;
};

type MonthlyScoreTrendCardProps = {
  currentScore: number;
  isDarkMode: boolean;
  points: MonthlyScoreTrendPoint[];
  className?: string;
  chartHeightClassName?: string;
};

export function MonthlyScoreTrendCard({
  currentScore,
  isDarkMode,
  points,
  className = "",
  chartHeightClassName = "h-[158px]"
}: MonthlyScoreTrendCardProps) {
  const [isInfoVisible, setIsInfoVisible] = useState(false);
  const gradientId = useId().replace(/:/g, "");
  const chartStroke = isDarkMode ? "rgba(255, 255, 255, 0.94)" : chartTokens.accentStrong;
  const areaTopColor = isDarkMode ? "#ffffff" : chartTokens.accentStrong;
  const areaBottomColor = isDarkMode ? "#ffffff" : chartTokens.accent;
  const areaTopOpacity = isDarkMode ? 0.07 : 0.16;
  const areaBottomOpacity = isDarkMode ? 0.01 : 0.05;
  const valueColor = isDarkMode ? "#ffffff" : "#0f172a";
  const unitColor = isDarkMode ? "#cbd5e1" : "#64748b";
  const labelColor = isDarkMode ? "#94a3b8" : "#64748b";

  return (
    <article
      className={`dashboard-card relative z-10 order-1 flex h-[280px] min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-1 xl:col-span-1 xl:col-start-1 xl:row-start-1 ${className}`.trim()}
    >
      <div className="relative flex items-center gap-1 px-3 pt-3">
        <p className="text-sm font-semibold leading-5 text-slate-900">월별 접근성 점수 추이</p>
        <button
          type="button"
          className="inline-flex h-5 w-5 shrink-0 translate-y-[1px] items-center justify-center rounded-full text-slate-500 transition-colors hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
          aria-label="월별 접근성 점수 추이 설명"
          onMouseEnter={() => setIsInfoVisible(true)}
          onMouseLeave={() => setIsInfoVisible(false)}
          onFocus={() => setIsInfoVisible(true)}
          onBlur={() => setIsInfoVisible(false)}
        >
          <Info size={15} strokeWidth={1.9} />
        </button>
        {isInfoVisible && (
          <div
            className="pointer-events-none absolute left-3 top-8 z-[130] w-56 rounded-lg bg-slate-950 px-3 py-2 text-left text-[11px] font-medium leading-relaxed text-white shadow-[0_14px_32px_rgba(2,6,23,0.28)]"
            role="tooltip"
          >
            최근 월별 평가 결과의 접근성 총점을 비교해 점수 흐름을 보여줍니다.
          </div>
        )}
      </div>

      <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-visible rounded-[28px] bg-white pt-3">
        <div className="px-4">
          <p className="text-[11px] font-semibold tracking-[0.08em]" style={{ color: labelColor }}>
            현재 점수
          </p>
          <p className="-ml-1 mt-0.5 text-[2rem] font-bold leading-none tracking-[-0.05em]" style={{ color: valueColor }}>
            <span className="tracking-[0.035em]">{currentScore}</span>
            <span className="ml-1 text-xl font-semibold tracking-normal" style={{ color: unitColor }}>
              점
            </span>
          </p>
        </div>

        <div className={`relative mt-auto overflow-hidden rounded-b-[28px] ${chartHeightClassName}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 16, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={areaTopColor} stopOpacity={areaTopOpacity} />
                  <stop offset="100%" stopColor={areaBottomColor} stopOpacity={areaBottomOpacity} />
                </linearGradient>
              </defs>
              <Tooltip
                cursor={{ stroke: chartStroke, strokeOpacity: 0.16, strokeWidth: 1 }}
                content={<MonthlyScoreTooltip />}
              />
              <Area
                type="monotone"
                dataKey="score"
                stroke={chartStroke}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                activeDot={{ r: 4, fill: chartStroke, strokeWidth: 0 }}
                dot={false}
                isAnimationActive
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </article>
  );
}

function MonthlyScoreTooltip({
  active,
  payload
}: {
  active?: boolean;
  payload?: Array<{ payload?: MonthlyScoreTrendPoint; value?: number }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0]?.payload;
  if (!point) {
    return null;
  }

  return (
    <div
      role="tooltip"
      className="min-w-24 rounded-lg px-3 py-2 text-left"
      style={{
        backgroundColor: "rgba(8, 8, 10, 0.96)",
        border: "1px solid rgba(255, 255, 255, 0.08)"
      }}
    >
      <p className="text-[11px] font-semibold" style={{ color: chartTokens.tooltipSubtle }}>
        {point.month}
      </p>
      <p className="mt-1 text-sm font-bold" style={{ color: chartTokens.tooltipText }}>
        {point.score}점
      </p>
    </div>
  );
}
