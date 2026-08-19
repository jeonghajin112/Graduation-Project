import type { DashboardViewModel, IssueResultModel, SeverityLevel } from "@/types/accessibility-domain";

import { categoryLabelMap, severityLabelMap } from "../../shared/constants";
import { buildLatestEvaluationRequestByTargetId } from "../../shared/evaluation-request-selection";
import type { TopIssueSummary } from "../../shared/score-utils";

export type IssueCategoryKey = "perceivable" | "operable" | "understandable" | "robust";

export const severityKeys = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

export const severityTrendColors: Record<SeverityLevel, string> = {
  CRITICAL: "#ef4444",
  HIGH: "#f97316",
  MEDIUM: "#f59e0b",
  LOW: "#38bdf8"
};

const baseIssueCategoryKeys = ["perceivable", "operable", "understandable", "robust"] as const;
const issueCodeLabelMap: Record<string, string> = {
  "5.1.1": "적절한 대체 텍스트 제공",
  "img-alt": "대체 텍스트",
  "heading-order": "제목 구조",
  "color-contrast": "색상 대비",
  "keyboard-focus": "초점 표시",
  "label-missing": "레이블/지시사항"
};
const issueCodeSummaryMap: Record<string, string> = {
  "5.1.1": "정보성 이미지에 대체 텍스트가 필요합니다.",
  "img-alt": "이미지 의미를 스크린리더가 전달할 수 있도록 대체 텍스트가 필요합니다.",
  "heading-order": "제목, 목록, 관계 정보가 화면 구조뿐 아니라 의미 구조로도 전달되어야 합니다.",
  "color-contrast": "텍스트와 배경의 대비가 충분해야 저시력 사용자도 내용을 읽을 수 있습니다.",
  "keyboard-focus": "키보드 탐색 중 현재 초점 위치가 시각적으로 명확하게 보여야 합니다.",
  "label-missing": "입력 폼에는 목적을 알 수 있는 레이블과 필요한 안내가 제공되어야 합니다."
};

export type IssueCategoryRow = {
  category: IssueCategoryKey;
  label: string;
  count: number;
} & Record<SeverityLevel, number>;

export type DonutSegment = IssueCategoryRow & {
  color: string;
  percentage: number;
  dash: number;
  offset: number;
};

export type WcagViolationRow = {
  issueCode: string;
  kwcagLabel: string;
  shortRef: string;
  label: string;
  description: string;
  categoryLabel: string;
  count: number;
  dominantSeverity: SeverityLevel;
  severityLabel: string;
};

export function createEmptySeverityCounts(): Record<SeverityLevel, number> {
  return {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0
  };
}

export function getIssueCategoryKey(issueCode: string): IssueCategoryKey {
  const kwcagGroup = issueCode.trim().match(/^([5-8])(?:\.|$)/)?.[1];
  if (kwcagGroup === "5") {
    return "perceivable";
  }
  if (kwcagGroup === "6") {
    return "operable";
  }
  if (kwcagGroup === "7") {
    return "understandable";
  }
  if (kwcagGroup === "8") {
    return "robust";
  }

  if (issueCode === "5.1.1" || issueCode.includes("contrast") || issueCode.includes("alt")) {
    return "perceivable";
  }
  if (issueCode.includes("keyboard") || issueCode.includes("focus")) {
    return "operable";
  }
  if (issueCode.includes("label") || issueCode.includes("heading")) {
    return "understandable";
  }
  return "robust";
}

export function getKwcagLabel(issueCode: string): string {
  const normalizedIssueCode = issueCode.trim();
  return normalizedIssueCode ? `KWCAG ${normalizedIssueCode}` : "KWCAG 기준";
}

export function buildRequestIssueContext(data: DashboardViewModel) {
  const requestIdByAnalysisResultId = new Map(
    data.analysisResults.map((analysisResult) => [analysisResult.id, analysisResult.evaluationRequestId])
  );
  const materializedRequestIds = new Set([
    ...data.resultSummaries.map((summary) => summary.requestId),
    ...data.scoreResults.map((scoreResult) => scoreResult.evaluationRequestId),
    ...data.analysisResults.map((analysisResult) => analysisResult.evaluationRequestId)
  ]);
  const latestResultRequestByTargetId = buildLatestEvaluationRequestByTargetId(
    data.evaluationRequests,
    materializedRequestIds
  );
  const currentResultRequestIds = new Set(
    [...latestResultRequestByTargetId.values()].map((request) => request.id)
  );
  const hasMaterializedResultContext = currentResultRequestIds.size > 0;
  const currentIssueResults = hasMaterializedResultContext
    ? data.issueResults.filter((issue) => {
        const requestId = requestIdByAnalysisResultId.get(issue.analysisResultId);
        return typeof requestId === "number" && currentResultRequestIds.has(requestId);
      })
    : data.issueResults;

  return {
    currentIssueResults,
    currentResultRequestIds,
    hasMaterializedResultContext,
    requestIdByAnalysisResultId
  };
}

export function buildIssueCategoryRows(currentIssueResults: IssueResultModel[]): IssueCategoryRow[] {
  const categoryRows = baseIssueCategoryKeys.map((category) => ({
    category,
    label: categoryLabelMap[category] ?? category,
    count: 0,
    ...createEmptySeverityCounts()
  }));
  const categoryRowByKey = new Map(categoryRows.map((row) => [row.category, row]));

  for (const issue of currentIssueResults) {
    const category = getIssueCategoryKey(issue.issueCode);
    const categoryRow = categoryRowByKey.get(category);
    if (!categoryRow) {
      continue;
    }
    categoryRow.count += 1;
    categoryRow[issue.severity] += 1;
  }

  return categoryRows;
}

export function buildRoundedPercentages(counts: number[]): number[] {
  const totalCount = counts.reduce((sum, count) => sum + count, 0);
  if (totalCount <= 0 || counts.length === 0) {
    return counts.map(() => 0);
  }

  const rawPercentages = counts.map((count) => (count / totalCount) * 100);
  const floored = rawPercentages.map((value) => Math.floor(value));
  const remainders = rawPercentages
    .map((value, index) => ({ index, remainder: value - floored[index]! }))
    .sort((a, b) => b.remainder - a.remainder);

  for (let i = 0; i < 100 - floored.reduce((sum, value) => sum + value, 0); i += 1) {
    const target = remainders[i];
    if (!target) {
      break;
    }
    floored[target.index] += 1;
  }

  return floored;
}

export function buildDonutSegments(
  categoryRows: IssueCategoryRow[],
  circumference: number,
  colors: readonly string[]
): DonutSegment[] {
  const totalCategoryCount = categoryRows.reduce((sum, row) => sum + row.count, 0);
  const categoryPercentages = buildRoundedPercentages(categoryRows.map((row) => row.count));
  let donutOffset = 0;

  return categoryRows.map((row, index) => {
    const fraction = totalCategoryCount > 0 ? row.count / totalCategoryCount : 0;
    const dash = fraction * circumference;
    const segment = {
      ...row,
      color: colors[index % colors.length] ?? "#94a3b8",
      percentage: categoryPercentages[index] ?? 0,
      dash,
      offset: -donutOffset
    };
    donutOffset += dash;
    return segment;
  });
}

export function buildOpenSeverityCounts({
  currentIssueResults,
  hasMaterializedResultContext,
  topIssueSummaries
}: {
  currentIssueResults: IssueResultModel[];
  hasMaterializedResultContext: boolean;
  topIssueSummaries: TopIssueSummary[];
}): Record<SeverityLevel, number> {
  const counts = createEmptySeverityCounts();

  if (currentIssueResults.length > 0 || hasMaterializedResultContext) {
    for (const issue of currentIssueResults) {
      counts[issue.severity] += 1;
    }
  } else {
    for (const issue of topIssueSummaries) {
      counts[issue.severity] += issue.count;
    }
  }

  return counts;
}

export function buildSeverityBarRows(counts: Record<SeverityLevel, number>) {
  const issueCount = severityKeys.reduce((sum, severity) => sum + counts[severity], 0);
  const maxSeveritySegmentCount = Math.max(1, ...severityKeys.map((severity) => counts[severity]));

  return severityKeys.map((severity) => {
    const count = counts[severity];
    const percentage = issueCount > 0 ? (count / issueCount) * 100 : 0;

    return {
      severity,
      label: severityLabelMap[severity],
      count,
      percentage,
      roundedPercentage: Math.round(percentage),
      color: severityTrendColors[severity],
      heightPercentage: count > 0 ? Math.max((count / maxSeveritySegmentCount) * 100, 8) : 0
    };
  });
}

export function buildWcagViolationRows({
  currentIssueResults,
  hasMaterializedResultContext,
  topIssueSummaries
}: {
  currentIssueResults: IssueResultModel[];
  hasMaterializedResultContext: boolean;
  topIssueSummaries: TopIssueSummary[];
}): WcagViolationRow[] {
  const wcagViolationSummary = new Map<
    string,
    {
      issueCode: string;
      count: number;
      severityCounts: Record<SeverityLevel, number>;
      issueTitles: Set<string>;
      descriptions: Set<string>;
      categories: Set<IssueCategoryKey>;
    }
  >();
  const addWcagViolation = (input: {
    issueCode: string;
    issueTitle?: string;
    message?: string;
    severity: SeverityLevel;
    count: number;
  }) => {
    const issueCode = input.issueCode.trim().length > 0 ? input.issueCode.trim() : "issue-unclassified";
    const current =
      wcagViolationSummary.get(issueCode) ??
      {
        issueCode,
        count: 0,
        severityCounts: createEmptySeverityCounts(),
        issueTitles: new Set<string>(),
        descriptions: new Set<string>(),
        categories: new Set<IssueCategoryKey>()
      };

    current.count += input.count;
    current.severityCounts[input.severity] += input.count;
    current.issueTitles.add(input.issueTitle ?? issueCodeLabelMap[issueCode] ?? issueCode);
    current.descriptions.add(input.message ?? issueCodeSummaryMap[issueCode] ?? "해당 이슈 유형의 반복 발생 여부를 우선 확인해 주세요.");
    current.categories.add(getIssueCategoryKey(issueCode));
    wcagViolationSummary.set(issueCode, current);
  };

  if (currentIssueResults.length > 0 || hasMaterializedResultContext) {
    for (const issue of currentIssueResults) {
      addWcagViolation({
        issueCode: issue.issueCode,
        issueTitle: issue.issueTitle,
        message: issue.message,
        severity: issue.severity,
        count: 1
      });
    }
  } else {
    for (const issue of topIssueSummaries) {
      addWcagViolation({
        issueCode: issue.issueCode,
        severity: issue.severity,
        count: issue.count
      });
    }
  }

  return [...wcagViolationSummary.values()]
    .map((row) => {
      const dominantSeverity = severityKeys.reduce((current, severity) =>
        row.severityCounts[severity] > row.severityCounts[current] ? severity : current
      );

      return {
        issueCode: row.issueCode,
        kwcagLabel: getKwcagLabel(row.issueCode),
        shortRef: row.issueCode,
        label: [...row.issueTitles][0] ?? "이슈 유형 미확인",
        description: [...row.descriptions][0] ?? "해당 이슈 유형의 반복 발생 여부를 우선 확인해 주세요.",
        categoryLabel: [...row.categories]
          .map((category) => categoryLabelMap[category] ?? category)
          .filter((category, index, categories) => categories.indexOf(category) === index)
          .join(" · "),
        count: row.count,
        dominantSeverity,
        severityLabel: severityLabelMap[dominantSeverity]
      };
    })
    .sort((a, b) => b.count - a.count || a.issueCode.localeCompare(b.issueCode));
}
