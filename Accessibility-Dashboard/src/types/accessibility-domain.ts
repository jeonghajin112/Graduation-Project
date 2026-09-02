export type MenuType = "analyze" | "projects";

export type ApiResponse<T> = {
  success: boolean;
  data: T;
  message: string | null;
};

export type EvaluationStatus = "PENDING" | "IN_PROGRESS" | "RUNNING" | "COMPLETED" | "FAILED";
export type EvaluationIssueSeverity = "CRITICAL" | "SERIOUS" | "MODERATE" | "MINOR";
export type EvaluationModule = "rule_based" | "text_difficulty" | "cv_visual";
export type RequestStatus = EvaluationStatus;
export type AnalysisStatus = "SUCCESS" | "FAILED";
export type AnalyzerType = "RULE_BASED" | "AI_TEXT" | "CV_VISION";
export type SeverityLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ScoreCategory = "rule_based" | "difficulty" | "cv";

export type Organization = {
  id: number;
  name: string;
  type: string;
  homepageUrl: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationTarget = {
  id: number;
  organizationId: number;
  name: string;
  targetType: string;
  accessUrl: string;
  faviconUrl?: string | null;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationRequest = {
  id: number;
  evaluationTargetId: number;
  targetName?: string;
  faviconUrl?: string | null;
  status: RequestStatus;
  requestNote: string;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationResultSummary = {
  requestId: number;
  targetName: string;
  status: EvaluationStatus;
  totalScore: number;
  totalIssueCount: number;
  criticalIssueCount: number;
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

export type IssueLocator = {
  kind: string;
  pathSteps: IssueLocatorPathStep[];
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  coordinateSpace: string | null;
  visible: boolean | null;
  htmlSnippet: string | null;
};

export type EvaluationArtifact = {
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
  captureMode: "DOM_REPLAY";
  contentUrl: string;
  contentType: "text/html";
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
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
  ruleScore: number;
  aiScore: number;
  cvScore: number;
  createdAt: string;
  updatedAt: string;
};

export type ScoreDetail = {
  id: number;
  scoreResultId?: number;
  category: ScoreCategory;
  score: number;
  maxScore: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
};

export type ImprovementGuide = {
  id: number;
  issueResultId: number;
  title: string;
  guideContent: string;
  exampleCode: string;
  recommendation: string;
  createdAt: string;
  updatedAt: string;
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
  id: number;
  name: string;
  type: string;
  homepageUrl: string;
  description: string;
  status: RequestStatus | string;
  createdAt: string;
  updatedAt: string;
  evaluationTargets: EvaluationTargetModel[];
};

export type EvaluationRequestModel = EvaluationRequest;
export type IssueResultModel = IssueResult;

export type DashboardIssueGroup = {
  issueCode: string;
  issueTitle: string;
  severity: SeverityLevel;
  count: number;
};

export type DashboardLatestIssueCount = {
  evaluationTargetId: number;
  requestId: number;
  totalIssueCount: number;
  criticalIssueCount: number;
  highIssueCount: number;
  mediumIssueCount: number;
  lowIssueCount: number;
  groups: DashboardIssueGroup[];
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
