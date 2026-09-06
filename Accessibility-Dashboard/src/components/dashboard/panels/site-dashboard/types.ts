import type { AnalyzerType, IssueResultModel, SeverityLevel } from "@/types/accessibility-domain";
import type { LocatorConnectionStatus } from "./page-replay-protocol";

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

export type LocatorCheckState = "loading" | "ready" | "error";

export type LocatorIssueState = {
  status: LocatorConnectionStatus;
  reason?: string;
  recoverable?: boolean;
};

export type LocatorReport = {
  requestId: number | null;
  issueIdsSignature: string;
  state: LocatorCheckState;
  unavailableIssueIds: number[];
  recoverableHiddenIssueIds: number[];
  issueStates: Record<number, LocatorIssueState>;
};
