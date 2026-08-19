import type { ChartConfig } from "@/components/ui/line-charts-6";

import type { ChartSeriesKey, SeverityChartItem, WcagCriterion } from "./types";

export const chartConfig = {
  score: {
    label: "평균 점수",
    color: "var(--site-score-line-color)"
  },
  issueCount: {
    label: "문제 수",
    color: "#ff8a00"
  }
} satisfies ChartConfig;

export const chartLineVisibility: Record<ChartSeriesKey, boolean> = {
  score: true,
  issueCount: true
};

export const scoreGridLines = [0, 20, 40, 60, 80, 100];

export const severityChartItems: SeverityChartItem[] = [
  { key: "CRITICAL", label: "심각", color: "#f35f63" },
  { key: "HIGH", label: "높음", color: "#fb8a3d" },
  { key: "MEDIUM", label: "중간", color: "#f3b234" },
  { key: "LOW", label: "낮음", color: "#10b981" }
];

export const wcagCriterionByIssueCode: Record<string, WcagCriterion> = {
  "img-alt": {
    criterion: "1.1.1",
    title: "Non-text Content"
  },
  "heading-order": {
    criterion: "1.3.1",
    title: "Info and Relationships"
  },
  "color-contrast": {
    criterion: "1.4.3",
    title: "Contrast (Minimum)"
  },
  "keyboard-focus": {
    criterion: "2.4.7",
    title: "Focus Visible"
  },
  "label-missing": {
    criterion: "3.3.2",
    title: "Labels or Instructions"
  }
};

export const fallbackWcagCriterion: WcagCriterion = {
  criterion: "확인 필요",
  title: "WCAG 기준"
};
