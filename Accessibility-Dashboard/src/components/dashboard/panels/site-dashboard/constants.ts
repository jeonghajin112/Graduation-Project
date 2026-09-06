import type { ChartConfig } from "@/components/ui/line-charts-6";

import type { SeverityChartItem } from "./types";

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

export const severityChartItems: SeverityChartItem[] = [
  { key: "CRITICAL", label: "심각", color: "#f35f63" },
  { key: "HIGH", label: "높음", color: "#fb8a3d" },
  { key: "MEDIUM", label: "중간", color: "#f3b234" },
  { key: "LOW", label: "낮음", color: "#10b981" }
];

const criterionByLegacyIssueCode: Record<string, string> = {
  "img-alt": "5.1.1",
  "heading-order": "5.3.2",
  "color-contrast": "5.4.3",
  "keyboard-focus": "6.1.2",
  "label-missing": "7.3.2"
};

const kwcagCriterionPattern = /^[0-9]+(?:[.][0-9]+)+$/;

export function normalizeIssueCode(issueCode: string): string {
  const normalizedCode = issueCode.trim();
  return criterionByLegacyIssueCode[normalizedCode] ?? normalizedCode;
}

export function formatIssueCodeLabel(issueCode: string): string {
  const normalizedCode = normalizeIssueCode(issueCode);

  if (!normalizedCode) {
    return "";
  }

  if (/^(?:KWCAG|WCAG)\s+/i.test(normalizedCode)) {
    return normalizedCode;
  }

  return kwcagCriterionPattern.test(normalizedCode)
    ? `KWCAG ${normalizedCode}`
    : normalizedCode;
}
