export type MenuType = "dashboard" | "analyze" | "projects" | "reports" | "project-create";

export type ApiResponse<T> = {
  success: boolean;
  data: T;
  message: string | null;
};

export type EvaluationStatus = "PENDING" | "IN_PROGRESS" | "RUNNING" | "COMPLETED" | "FAILED";
export type EvaluationIssueSeverity = "CRITICAL" | "SERIOUS" | "MODERATE" | "MINOR" | "INFO";
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
  totalScore: number | null;
  totalIssueCount: number;
  criticalIssueCount: number;
  requestedAt: string | null;
};

export type IssueLocatorContext = "DOCUMENT" | "FRAME" | "SHADOW_ROOT";

export type IssueLocatorPathStep = {
  context: IssueLocatorContext;
  selector: string;
  frameUrl?: string | null;
};

export type IssueLocator = {
  kind: string;
  pathSteps: IssueLocatorPathStep[];
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

export type EvaluationIssue = {
  id: number | string;
  requestId: number;
  module: string;
  severity: EvaluationIssueSeverity;
  title: string;
  description: string;
  recommendation?: string | null;
  selector?: string | null;
  locator?: IssueLocator | null;
  wcagCode?: string | null;
  createdAt?: string | null;
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

export type DashboardViewModel = {
  organizations: OrganizationModel[];
  evaluationRequests: EvaluationRequestModel[];
  resultSummaries: EvaluationResultSummary[];
  evaluationIssues: EvaluationIssue[];
  analysisResults: AnalysisResult[];
  scoreResults: ScoreResult[];
  scoreDetails: ScoreDetail[];
  issueResults: IssueResultModel[];
  improvementGuides: ImprovementGuide[];
};

export type DashboardApiResponse = {
  organizations: Organization[];
  evaluationTargets: EvaluationTarget[];
  evaluationRequests: EvaluationRequest[];
  analysisResults: AnalysisResult[];
  issueResults: IssueResult[];
  scoreResults: ScoreResult[];
  scoreDetails?: ScoreDetail[];
  improvementGuides?: ImprovementGuide[];
};

export type CreateEvaluationTargetInput = {
  projectId: number;
  name: string;
  accessUrl: string;
};
