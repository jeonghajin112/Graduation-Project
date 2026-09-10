export type MenuType = "analyze" | "projects";

export type RequestStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
export type EvaluationStatus = RequestStatus | "RUNNING";
export type EvaluationIssueSeverity = "CRITICAL" | "SERIOUS" | "MODERATE" | "MINOR";
export type EvaluationModule = "rule_based" | "text_difficulty" | "cv_visual";
export type AnalysisStatus = "SUCCESS" | "FAILED";
export type AnalyzerType = "RULE_BASED" | "AI_TEXT" | "CV_VISION";
export type SeverityLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type Organization = {
  systemManaged?: boolean;
  id: number;
  name: string;
  description: string;
  status: string;
  updatedAt: string;
};

export type EvaluationTarget = {
  id: number;
  organizationId: number;
  name: string;
  targetType: string;
  accessUrl: string;
  faviconUrl?: string | null;
  status: string;
  createdAt: string;
};

export type EvaluationRequest = {
  quickAnalysis?: boolean;
  id: number;
  evaluationTargetId: number;
  status: RequestStatus;
  requestedAt: string;
  updatedAt: string;
};

export type EvaluationResultSummary = {
  requestId: number;
  totalScore: number;
  totalIssueCount: number;
  requestedAt: string;
};

// The backend preserves legacy/custom locator context strings. Replay support
// is narrowed at runtime in issue-locator.ts instead of pretending the wire
// contract is a closed enum.
export type IssueLocatorContext = string;

export type IssueLocatorPathStep = {
  context: IssueLocatorContext;
  selector: string;
  frameUrl?: string | null;
};

export type IssueLocatorCarouselContext = {
  carouselId: number;
  slideIndex: number;
  slideCount: number;
};

export type IssueLocator = {
  pathSteps: IssueLocatorPathStep[];
  carouselContext?: IssueLocatorCarouselContext | null;
  htmlSnippet?: string | null;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  coordinateSpace?: string | null;
};

export type EvaluationCaptureMetadata = {
  id: number;
  requestId: number;
  requestedUrl: string;
  finalUrl: string;
  capturedAt: string;
  viewportWidthCssPx: number;
  viewportHeightCssPx: number;
  deviceScaleFactor: number;
  pageWidthCssPx: number;
  pageHeightCssPx: number;
};

export type LiveReportSession = {
  sessionId: string;
  runtimeUrl: string;
  viewerOrigin: string;
  nonce: string;
  bridgeSecret: string;
  expiresAt: string;
};

export type EvaluationIssue = {
  id: number;
  requestId: number;
  module: EvaluationModule;
  severity: EvaluationIssueSeverity;
  title: string;
  description: string | null;
  recommendation: string | null;
  selector: string | null;
  locator: IssueLocator | null;
  wcagCode: string;
  createdAt: string;
};

export type AnalysisResult = {
  id: number;
  evaluationRequestId: number;
  analyzerType: AnalyzerType;
  status: AnalysisStatus;
  summary: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IssueResult = {
  id: number;
  analysisResultId: number;
  issueCode: string;
  issueTitle: string;
  severity: SeverityLevel;
  locationPath: string;
  locator?: IssueLocator | null;
  message: string;
  recommendation?: string | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ScoreResult = {
  id: number;
  evaluationRequestId: number;
  totalScore: number;
  // Optional for older APIs. Null means no measured score; zero is a real score.
  cvScore?: number | null;
  cvStatus?: "SUCCESS" | "NOT_MEASURED" | "FAILED" | null;
};

export type EvaluationTargetModel = {
  id: number;
  name: string;
  targetType: string;
  accessUrl: string;
  faviconUrl?: string | null;
  status: RequestStatus | string;
  createdAt: string;
};

export type OrganizationModel = {
  systemManaged?: boolean;
  id: number;
  name: string;
  description: string;
  status: RequestStatus | string;
  updatedAt: string;
  evaluationTargets: EvaluationTargetModel[];
};

export type EvaluationRequestModel = EvaluationRequest;
export type IssueResultModel = IssueResult;

export type DashboardLatestIssueCount = {
  evaluationTargetId: number;
  requestId: number;
};

export type DashboardViewModel = {
  organizations: OrganizationModel[];
  evaluationRequests: EvaluationRequestModel[];
  resultSummaries: EvaluationResultSummary[];
  latestIssueCounts: DashboardLatestIssueCount[];
  scoreResults: ScoreResult[];
};

export type DashboardOverviewApiResponse = {
  organizations: Array<Organization & { evaluationTargets: EvaluationTarget[] }>;
  evaluationRequests: EvaluationRequest[];
  resultSummaries: EvaluationResultSummary[];
  scoreResults: ScoreResult[];
  latestIssueCounts: DashboardLatestIssueCount[];
};

export type CreateEvaluationTargetInput = {
  projectId: number;
  name: string;
  accessUrl: string;
};
