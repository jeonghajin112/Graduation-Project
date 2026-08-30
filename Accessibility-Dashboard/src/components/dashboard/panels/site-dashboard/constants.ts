import type { ChartConfig } from "@/components/ui/line-charts-6";

import type { SeverityChartItem, WcagCriterion } from "./types";

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

export const wcagCriterionByIssueCode: Record<string, WcagCriterion> = {
  "img-alt": {
    criterion: "5.1.1",
    title: "적절한 대체 텍스트 제공"
  },
  "heading-order": {
    criterion: "5.3.2",
    title: "콘텐츠의 선형구조"
  },
  "color-contrast": {
    criterion: "5.4.3",
    title: "텍스트 콘텐츠의 명도 대비"
  },
  "keyboard-focus": {
    criterion: "6.1.2",
    title: "초점 이동과 표시"
  },
  "label-missing": {
    criterion: "7.3.2",
    title: "레이블 제공"
  }
};

const kwcagCriterionPattern = /^[0-9]+(?:[.][0-9]+)+$/;

export function normalizeIssueCode(issueCode: string): string {
  const normalizedCode = issueCode.trim();
  return wcagCriterionByIssueCode[normalizedCode]?.criterion ?? normalizedCode;
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

export function resolveWcagCriterion(issueCode: string, issueTitle: string): WcagCriterion {
  const normalizedCode = issueCode.trim();
  return (
    wcagCriterionByIssueCode[normalizedCode] ?? {
      // Backend KWCAG identifiers such as 5.3.3 are already canonical. Keep
      // them intact; custom analyzer identifiers remain distinct as well.
      criterion: normalizedCode,
      title: issueTitle
    }
  );
}
