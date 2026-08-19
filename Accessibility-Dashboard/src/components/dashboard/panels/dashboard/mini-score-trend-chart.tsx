import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { useId } from "react";

import { chartTokens } from "../../shared/constants";

type MiniScoreTrendChartProps = {
  ariaLabel: string;
  isDarkMode: boolean;
  series: number[];
};

export function MiniScoreTrendChart({ ariaLabel, isDarkMode, series }: MiniScoreTrendChartProps) {
  const gradientId = useId().replace(/:/g, "");
  const chartStroke = isDarkMode ? "rgba(255, 255, 255, 0.94)" : chartTokens.accentStrong;
  const areaTopColor = isDarkMode ? "#ffffff" : chartTokens.accentStrong;
  const areaBottomColor = isDarkMode ? "#ffffff" : chartTokens.accent;
  const data = series.map((score, index) => ({
    index,
    score
  }));

  return (
    <div className="absolute inset-0" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={areaTopColor} stopOpacity={isDarkMode ? 0.07 : 0.16} />
              <stop offset="100%" stopColor={areaBottomColor} stopOpacity={isDarkMode ? 0.01 : 0.05} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="score"
            stroke={chartStroke}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={false}
            isAnimationActive
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
