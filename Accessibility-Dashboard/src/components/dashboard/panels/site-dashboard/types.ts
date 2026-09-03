import type { AnalyzerType, IssueResultModel, SeverityLevel } from "@/types/accessibility-domain";

export type ScoreChartItem = {
  slot: number;
  date: string;
  label: string;
  score: number;
  issueCount: number;
  isPlaceholder?: boolean;
};

export type SeverityChartItem = {
  key: SeverityLevel;
  label: string;
  color: string;
};

export type RecentIssueRow = {
  issue: IssueResultModel;
  severity: SeverityChartItem;
  analyzerType?: AnalyzerType;
};
