import type { AnalyzerType, ImprovementGuide, IssueResultModel, SeverityLevel } from "@/types/accessibility-domain";

export type ChartSeriesKey = "score" | "issueCount";

export type ScoreChartItem = {
  slot: number;
  date: string;
  label: string;
  score: number;
  issueCount: number;
};

export type SiteSummaryItem = {
  label: string;
  value: string;
  unit: string;
};

export type SeverityChartItem = {
  key: SeverityLevel;
  label: string;
  color: string;
};

export type IssueSeverityRow = SeverityChartItem & {
  count: number;
  percent: number;
};

export type WcagCriterion = {
  criterion: string;
  title: string;
};

export type RecentIssueRow = {
  issue: IssueResultModel;
  severity: SeverityChartItem;
  wcagCriterion: WcagCriterion;
  issueGuides: ImprovementGuide[];
  analyzerLabel: string;
  analyzerType?: AnalyzerType;
  showsAiGuide: boolean;
};
