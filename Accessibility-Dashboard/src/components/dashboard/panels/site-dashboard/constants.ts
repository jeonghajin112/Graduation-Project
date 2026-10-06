import type { SeverityChartItem } from "./types";

// Severity colors are CSS tokens (src/styles/theme-tokens.css). `color` is a
// CSS value assigned to custom properties in inline styles, so it must stay a
// CSS expression — it is never read as a literal hex in JavaScript.
export const severityChartItems: SeverityChartItem[] = [
  { key: "CRITICAL", label: "심각", color: "var(--site-severity-critical-fill)" },
  { key: "HIGH", label: "높음", color: "var(--site-severity-high-fill)" },
  { key: "MEDIUM", label: "중간", color: "var(--site-severity-medium-fill)" },
  { key: "LOW", label: "낮음", color: "var(--site-severity-low-fill)" }
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
