import { Info } from "lucide-react";
import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { chartTokens } from "../../shared/constants";
import type { DonutSegment } from "./dashboard-panel-model";

type IssueRatioDonutCardProps = {
  isDarkMode: boolean;
  segments: DonutSegment[];
};

export function IssueRatioDonutCard({ isDarkMode, segments }: IssueRatioDonutCardProps) {
  const [isInfoVisible, setIsInfoVisible] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const legendText = isDarkMode ? "#94a3b8" : "#64748b";
  const activeLegendText = isDarkMode ? "#dbe4f3" : "#0f172a";
  const chartData = useMemo(
    () =>
      segments.map((segment) => ({
        ...segment,
        value: segment.count
      })),
    [segments]
  );

  return (
    <article className="dashboard-card order-3 flex h-[348px] min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-1 xl:col-span-1 xl:col-start-1 xl:row-start-2">
      <div className="min-h-[36px] px-3 pt-3">
        <div className="relative flex items-center gap-1">
          <p className="text-sm font-semibold leading-5 text-slate-900">이슈 분야별 비율</p>
          <button
            type="button"
            className="inline-flex h-5 w-5 shrink-0 translate-y-[1px] items-center justify-center rounded-full text-slate-500 transition-colors hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            aria-label="이슈 분야별 비율 설명"
            onMouseEnter={() => setIsInfoVisible(true)}
            onMouseLeave={() => setIsInfoVisible(false)}
            onFocus={() => setIsInfoVisible(true)}
            onBlur={() => setIsInfoVisible(false)}
          >
            <Info size={15} strokeWidth={1.9} />
          </button>
          {isInfoVisible && (
            <div
              className="pointer-events-none absolute left-0 top-7 z-[130] w-60 rounded-lg bg-slate-950 px-3 py-2 text-left text-[11px] font-medium leading-relaxed text-white shadow-[0_14px_32px_rgba(2,6,23,0.28)]"
              role="tooltip"
            >
              현재 집계된 이슈를 접근성 분야별 비중으로 나눠 보여줍니다.
            </div>
          )}
        </div>
      </div>
      <div className="mt-1 flex min-h-0 flex-1 flex-col rounded-[28px] bg-transparent p-3">
        <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 pt-0">
          <div className="h-[174px] w-[174px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip content={<IssueRatioTooltip />} />
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius="62%"
                  outerRadius="82%"
                  paddingAngle={0}
                  stroke="none"
                  isAnimationActive
                  onMouseEnter={(entry) => setActiveCategory((entry as unknown as DonutSegment).category)}
                  onMouseLeave={() => setActiveCategory(null)}
                >
                  {chartData.map((segment) => (
                    <Cell
                      key={segment.category}
                      fill={segment.color}
                      fillOpacity={activeCategory === segment.category ? 0.88 : 0.68}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="grid w-full max-w-[300px] grid-cols-2 items-center justify-items-center gap-x-4 gap-y-1 text-center">
            {segments.map((segment) => (
              <div
                key={segment.category}
                className="flex items-center justify-center gap-1.5 px-1 py-0.5 text-[11px] transition-colors"
                style={{
                  color: activeCategory === segment.category ? activeLegendText : legendText
                }}
              >
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />
                <span className="whitespace-nowrap font-medium">{segment.label}</span>
                <span className="font-bold">{segment.percentage}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

function IssueRatioTooltip({
  active,
  payload
}: {
  active?: boolean;
  payload?: Array<{ payload?: DonutSegment }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const segment = payload[0]?.payload;
  if (!segment) {
    return null;
  }

  return (
    <div
      className="min-w-28 rounded-lg px-3 py-3 text-left"
      style={{
        backgroundColor: "rgba(8, 8, 10, 0.96)",
        border: "1px solid rgba(255, 255, 255, 0.08)"
      }}
      role="tooltip"
    >
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />
        <p className="text-sm font-semibold" style={{ color: chartTokens.tooltipText }}>
          {segment.label}
        </p>
      </div>
      <p className="mt-2 text-2xl font-bold" style={{ color: chartTokens.tooltipText }}>
        {segment.percentage}%
      </p>
      <p className="text-[11px]" style={{ color: chartTokens.tooltipSubtle }}>
        {segment.count}건
      </p>
    </div>
  );
}
