import type { SeverityLevel } from "@/types/accessibility-domain";

export type ScanStatus = "완료" | "진행중" | "실패" | "미실행";


export const severityLabelMap: Record<SeverityLevel, string> = {
  CRITICAL: "치명",
  HIGH: "높음",
  MEDIUM: "중간",
  LOW: "낮음"
};

export const categoryLabelMap: Record<string, string> = {
  perceivable: "인식 가능",
  operable: "운용 가능",
  understandable: "이해 가능",
  robust: "견고성"
};


export const chartTokens = {
  accent: "#ef6a50",
  accentStrong: "#e85d43",
  accentDim: "rgba(232, 93, 67, 0.58)",
  accentSoft: "rgba(239, 106, 80, 0.12)",
  accentSurface: "rgba(239, 106, 80, 0.07)",
  grid: "rgba(120, 113, 108, 0.12)",
  axis: "#75829c",
  legendBg: "rgba(31, 27, 24, 0.42)",
  legendBorder: "rgba(120, 113, 108, 0.14)",
  legendText: "#9f938a",
  tooltipBg: "rgba(15, 23, 42, 0.94)",
  tooltipBorder: "rgba(148, 163, 184, 0.16)",
  tooltipText: "#f8fafc",
  tooltipSubtle: "#94a3b8",
  donutPalette: ["#ef6a50", "#3b82f6", "#8b5cf6", "#10b981", "#f59e0b"]
} as const;

export const metricSparklineColors: Record<"orange" | "emerald" | "indigo" | "rose", string> = {
  orange: "#ef6a50",
  emerald: "#8f9b8e",
  indigo: "#111111",
  rose: "#d56c81"
};

