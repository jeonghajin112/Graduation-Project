import { Info } from "lucide-react";
import { useState } from "react";
import { PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip } from "recharts";

import { chartTokens } from "../../shared/constants";

type RadarScoreMetric = {
  key: string;
  label: string;
  value: number;
};

type RadarScoreMetricCardProps = {
  isDarkMode: boolean;
  rows: RadarScoreMetric[];
};

export function RadarScoreMetricCard({ isDarkMode, rows }: RadarScoreMetricCardProps) {
  const [isInfoVisible, setIsInfoVisible] = useState(false);
  const radarStroke = isDarkMode ? "rgba(255, 255, 255, 0.9)" : chartTokens.accentStrong;
  const radarFill = isDarkMode ? "rgba(255, 255, 255, 0.08)" : chartTokens.accentSoft;
  const radarGridStroke = isDarkMode ? "rgba(255, 255, 255, 0.12)" : "rgba(148, 163, 184, 0.2)";
  const radarLabelColor = isDarkMode ? "rgba(255, 255, 255, 0.72)" : "#64748b";

  return (
    <article className="dashboard-card order-4 flex h-[348px] min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-1 xl:col-span-1 xl:col-start-2 xl:row-start-2">
      <div className="min-h-[36px] px-3 pt-3">
        <div className="relative flex items-center gap-1">
          <p className="text-sm font-semibold leading-5 text-slate-900">분석 유형별 평균 점수</p>
          <button
            type="button"
            className="inline-flex h-5 w-5 shrink-0 translate-y-[1px] items-center justify-center rounded-full text-slate-500 transition-colors hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            aria-label="분석 유형별 평균 점수 설명"
            onMouseEnter={() => setIsInfoVisible(true)}
            onMouseLeave={() => setIsInfoVisible(false)}
            onFocus={() => setIsInfoVisible(true)}
            onBlur={() => setIsInfoVisible(false)}
          >
            <Info size={15} strokeWidth={1.9} />
          </button>
          {isInfoVisible && (
            <div
              className="pointer-events-none absolute left-0 top-7 z-[130] w-64 rounded-lg bg-slate-950 px-3 py-2 text-left text-[11px] font-medium leading-relaxed text-white shadow-[0_14px_32px_rgba(2,6,23,0.28)]"
              role="tooltip"
            >
              전체 평가 결과를 기준으로 시각 기반, 규칙 기반, 텍스트 기반 평균 점수를 비교해 보여줍니다.
            </div>
          )}
        </div>
      </div>
      <div className="mt-1 flex min-h-0 flex-1 flex-col rounded-[28px] bg-transparent px-2 py-1">
        <div className="relative flex min-w-0 flex-1 items-center justify-center pt-0">
          <div className="h-[242px] w-[242px]">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={rows} outerRadius="76%">
                <PolarGrid stroke={radarGridStroke} radialLines />
                <PolarAngleAxis dataKey="label" tick={{ fill: radarLabelColor, fontSize: 12.5, fontWeight: 600 }} />
                <Tooltip content={<RadarMetricTooltip />} />
                <Radar
                  dataKey="value"
                  stroke={radarStroke}
                  strokeWidth={2.2}
                  fill={radarFill}
                  fillOpacity={1}
                  isAnimationActive
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </article>
  );
}

function RadarMetricTooltip({
  active,
  payload
}: {
  active?: boolean;
  payload?: Array<{ payload?: RadarScoreMetric }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const row = payload[0]?.payload;
  if (!row) {
    return null;
  }

  return (
    <div
      className="min-w-24 rounded-lg px-3 py-2 text-left"
      style={{
        backgroundColor: "rgba(8, 8, 10, 0.96)",
        border: "1px solid rgba(255, 255, 255, 0.08)"
      }}
      role="tooltip"
    >
      <p className="text-[11px] font-semibold" style={{ color: chartTokens.tooltipSubtle }}>
        {row.label}
      </p>
      <p className="mt-1 text-sm font-bold" style={{ color: chartTokens.tooltipText }}>
        {row.value}점
      </p>
    </div>
  );
}
