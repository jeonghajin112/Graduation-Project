import { chartConfig } from "./constants";
import type { ScoreChartItem } from "./types";

export function getAnalyzerTypeLabel(analyzerType: string | undefined): string {
  if (!analyzerType) {
    return "출처 미확인";
  }

  const normalizedType = analyzerType.toLowerCase();
  if (normalizedType.includes("rule")) {
    return "규칙 기반";
  }
  if (normalizedType.includes("cv") || normalizedType.includes("visual") || normalizedType.includes("vision")) {
    return "시각 분석";
  }
  if (normalizedType.includes("text") || normalizedType.includes("difficulty") || normalizedType.includes("suggestion")) {
    return "AI 분석";
  }
  if (normalizedType.includes("integrated")) {
    return "통합 분석";
  }

  return analyzerType;
}

export function normalizeChartData(data: ScoreChartItem[]): ScoreChartItem[] {
  if (data.length >= 2) {
    return data;
  }

  if (data.length === 1) {
    return [
      {
        ...data[0]!,
        slot: 0,
        label: "이전"
      },
      {
        ...data[0]!,
        slot: 1
      }
    ];
  }

  return [createEmptyChartItem("이전", 0), createEmptyChartItem("현재", 1)];
}

export function getChartLabel(key: keyof typeof chartConfig): string {
  const label = chartConfig[key]?.label;
  return typeof label === "string" ? label : String(key);
}

export function getChartValueSuffix(key: keyof typeof chartConfig): "점" | "건" {
  return key === "issueCount" ? "건" : "점";
}

export function formatShortDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(5, 10).replace("-", ".");
  }

  return `${date.getMonth() + 1}.${date.getDate()}`;
}

export function formatDateKey(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDateLabel(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function createEmptyChartItem(label: string, slot: number): ScoreChartItem {
  return {
    slot,
    date: "",
    label,
    score: 0,
    issueCount: 0
  };
}
