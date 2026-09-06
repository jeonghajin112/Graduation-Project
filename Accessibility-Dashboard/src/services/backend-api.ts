import { buildApiUrl } from "@/config/api";
import {
  ApiContractValidationError,
  createEvaluationCaptureMetadataParser,
  createEvaluationIssuesResponseParser,
  createEvaluationRequestResponseParser,
  createEvaluationTargetResponseParser,
  createEvaluationTargetsResponseParser,
  createOrganizationResponseParser,
  parseDashboardOverviewResponse,
  parseEvaluationRequestsResponse,
  parseEvaluationRequestResponse,
  parseLiveReportSessionResponse,
  parseOrganizationResponse,
  parseVoidResponse,
  type ApiResponseParser
} from "@/services/api-contracts";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  AnalysisResult,
  CreateEvaluationTargetInput,
  DashboardViewModel,
  EvaluationCaptureMetadata,
  EvaluationIssue,
  EvaluationRequestModel,
  EvaluationTarget,
  EvaluationTargetModel,
  IssueResultModel,
  LiveReportSession,
  Organization,
  OrganizationModel
} from "@/types/accessibility-domain";

type ApiEnvelope<T> = {
  success: boolean;
  data: T;
  message: string | null;
  error?: string | null;
};

type ApiRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type ApiRequestOptions = {
  method?: ApiRequestMethod;
  body?: unknown;
  headers?: Record<string, string>;
  cache?: RequestCache;
  signal?: AbortSignal;
  optionalStatuses?: number[];
};

type ApiRequestErrorInput = {
  method: ApiRequestMethod;
  path: string;
  payload: unknown;
  status: number | null;
  url: string;
  message: string;
};

export class ApiRequestError extends Error {
  readonly method: ApiRequestMethod;
  readonly path: string;
  readonly payload: unknown;
  readonly status: number | null;
  readonly url: string;

  constructor({ method, path, payload, status, url, message }: ApiRequestErrorInput) {
    const statusLabel = status === null ? "" : `, HTTP ${status}`;
    // Keep request context in the diagnostic error only. Rendering code must
    // use getApiErrorMessage so internal paths and server payloads stay out of
    // the user interface.
    super(`${message} [${method} ${path}${statusLabel}]`);
    this.name = "ApiRequestError";
    this.method = method;
    this.path = path;
    this.payload = payload;
    this.status = status;
    this.url = url;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === null) {
      return "서비스에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 잠시 후 다시 시도해 주세요.";
    }

    if (error.status === 400 || error.status === 422) {
      return "입력한 내용을 확인한 뒤 다시 시도해 주세요.";
    }
    if (error.status === 401) {
      return "로그인 정보가 만료되었거나 확인되지 않았습니다. 다시 로그인해 주세요.";
    }
    if (error.status === 403) {
      return "이 작업을 수행할 권한이 없습니다. 권한이 필요하면 관리자에게 문의해 주세요.";
    }
    if (error.status === 404) {
      return "요청한 정보를 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.";
    }
    if (error.status === 408 || error.status === 504) {
      return "요청 처리에 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.";
    }
    if (error.status === 409) {
      return "다른 변경과 겹쳐 요청을 완료하지 못했습니다. 최신 상태를 불러온 뒤 다시 시도해 주세요.";
    }
    if (error.status === 413) {
      return "전송할 내용이 너무 큽니다. 크기를 줄인 뒤 다시 시도해 주세요.";
    }
    if (error.status === 429) {
      return "요청이 많아 잠시 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.";
    }
    if (error.status >= 500) {
      return "서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
    }

    return fallback;
  }

  if (error instanceof UserFacingError && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "success") &&
    typeof value.success === "boolean" &&
    Object.prototype.hasOwnProperty.call(value, "data") &&
    Object.prototype.hasOwnProperty.call(value, "message") &&
    (value.message === null || typeof value.message === "string") &&
    (!("error" in value) || value.error === null || typeof value.error === "string")
  );
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }

  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message;
  }

  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error;
  }

  return fallback;
}

function humanizeHttpError(status: number | null, fallback: string): string {
  if (status === 403) {
    return "요청이 거부되었습니다. 서버 CORS/권한 설정을 확인해 주세요.";
  }
  if (status === 404) {
    return "요청한 API를 찾을 수 없습니다.";
  }
  if (status === 500 || status === 502 || status === 503) {
    return "서버에서 분석 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (status === null) {
    return "서버에 연결하지 못했습니다. 백엔드가 실행 중인지 확인해 주세요.";
  }
  return fallback;
}

async function readJsonResponse(
  response: Response,
  context: { method: ApiRequestMethod; path: string; url: string }
): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON bodies (HTML/CORS 403 text) should not surface raw parser errors.
    throw new ApiRequestError({
      method: context.method,
      path: context.path,
      payload: text.slice(0, 500),
      status: response.status,
      url: context.url,
      message: humanizeHttpError(
        response.status,
        response.ok ? "서버 응답 형식이 올바르지 않습니다." : response.statusText || "API request failed."
      )
    });
  }
}

function unwrapSuccessfulPayload(
  payload: unknown,
  context: {
    method: ApiRequestMethod;
    path: string;
    status: number;
    url: string;
  }
): { value: unknown; fieldPath: string } {
  if (!isApiEnvelope(payload)) {
    if (!isRecord(payload)) {
      throw new ApiContractValidationError({
        fieldPath: "$",
        expected: "{ success, data, message } API 응답 envelope",
        actualType: payload === null ? "null" : Array.isArray(payload) ? "배열" : typeof payload
      });
    }
    if (
      !Object.prototype.hasOwnProperty.call(payload, "success") ||
      typeof payload.success !== "boolean"
    ) {
      throw new ApiContractValidationError({
        fieldPath: "success",
        expected: "불리언",
        actualType: payload.success === undefined ? "누락된" : typeof payload.success
      });
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "data")) {
      throw new ApiContractValidationError({
        fieldPath: "data",
        expected: "필수 필드",
        actualType: "누락된"
      });
    }
    const invalidMetadataKey = ["message", "error"].find(
      (key) =>
        (key === "message" && !Object.prototype.hasOwnProperty.call(payload, key)) ||
        (key in payload && payload[key] !== null && typeof payload[key] !== "string")
    );
    throw new ApiContractValidationError({
      fieldPath: invalidMetadataKey ?? "message",
      expected:
        invalidMetadataKey === "error"
          ? "문자열 또는 null"
          : "문자열 또는 null인 필수 필드",
      actualType:
        invalidMetadataKey === undefined || payload[invalidMetadataKey] === undefined
          ? "누락된"
          : typeof payload[invalidMetadataKey]
    });
  }

  if (!payload.success) {
    throw new ApiRequestError({
      method: context.method,
      path: context.path,
      payload,
      status: context.status,
      url: context.url,
      message: getErrorMessage(payload, "API request failed.")
    });
  }

  return { value: payload.data, fieldPath: "data" };
}

function parseSuccessfulResponse<T>({
  method,
  parser,
  path,
  payload,
  status,
  url
}: {
  method: ApiRequestMethod;
  parser: ApiResponseParser<T>;
  path: string;
  payload: unknown;
  status: number;
  url: string;
}): T {
  try {
    const unwrapped = unwrapSuccessfulPayload(payload, { method, path, status, url });
    return parser(unwrapped.value, unwrapped.fieldPath);
  } catch (error) {
    if (!(error instanceof ApiContractValidationError)) {
      throw error;
    }

    throw new ApiRequestError({
      method,
      path,
      payload,
      status,
      url,
      message: `서버 응답 계약이 올바르지 않습니다. ${error.message}`
    });
  }
}

async function apiRequest<T>(
  path: string,
  parser: ApiResponseParser<T>,
  { method = "GET", body, headers: extraHeaders, cache, signal, optionalStatuses = [] }: ApiRequestOptions = {}
): Promise<T> {
  const headers: HeadersInit = {
    Accept: "application/json",
    ...extraHeaders
  };
  const requestInit: RequestInit = {
    cache,
    method,
    headers,
    signal
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestInit.body = JSON.stringify(body);
  }

  const url = buildApiUrl(path);
  let response: Response;

  try {
    response = await fetch(url, {
      ...requestInit
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw new ApiRequestError({
      method,
      path,
      payload: error,
      status: null,
      url,
      message: humanizeHttpError(null, "Network request failed.")
    });
  }

  let payload: unknown;
  try {
    payload = await readJsonResponse(response, { method, path, url });
  } catch (error) {
    // readJsonResponse already wraps with ApiRequestError
    if (!response.ok && error instanceof ApiRequestError) {
      throw error;
    }
    throw error;
  }

  if (!response.ok) {
    if (optionalStatuses.includes(response.status)) {
      try {
        return parser(null, "data");
      } catch (error) {
        if (!(error instanceof ApiContractValidationError)) {
          throw error;
        }
        throw new ApiRequestError({
          method,
          path,
          payload,
          status: response.status,
          url,
          message: `서버 응답 계약이 올바르지 않습니다. ${error.message}`
        });
      }
    }

    throw new ApiRequestError({
      method,
      path,
      payload,
      status: response.status,
      url,
      message: getErrorMessage(
        payload,
        humanizeHttpError(response.status, response.statusText || "API request failed.")
      )
    });
  }

  return parseSuccessfulResponse({
    method,
    parser,
    path,
    payload,
    status: response.status,
    url
  });
}

async function apiGet<T>(
  path: string,
  parser: ApiResponseParser<T>,
  signal?: AbortSignal
): Promise<T> {
  return apiRequest(path, parser, { signal });
}

function compareByUpdatedAt(left: EvaluationRequestModel, right: EvaluationRequestModel): number {
  const leftUpdatedAt = Date.parse(left.updatedAt);
  const rightUpdatedAt = Date.parse(right.updatedAt);
  const comparableLeftUpdatedAt = Number.isNaN(leftUpdatedAt)
    ? Number.NEGATIVE_INFINITY
    : leftUpdatedAt;
  const comparableRightUpdatedAt = Number.isNaN(rightUpdatedAt)
    ? Number.NEGATIVE_INFINITY
    : rightUpdatedAt;
  const updatedAtDifference = comparableLeftUpdatedAt - comparableRightUpdatedAt;
  return updatedAtDifference === 0 ? left.id - right.id : updatedAtDifference;
}

function buildLatestRequestByTargetId(requests: EvaluationRequestModel[]): Map<number, EvaluationRequestModel> {
  const requestsByTargetId = new Map<number, EvaluationRequestModel[]>();
  for (const request of requests) {
    const current = requestsByTargetId.get(request.evaluationTargetId) ?? [];
    current.push(request);
    requestsByTargetId.set(request.evaluationTargetId, current);
  }

  return new Map(
    [...requestsByTargetId.entries()].map(([targetId, targetRequests]) => {
      const sortedRequests = [...targetRequests].sort(compareByUpdatedAt);
      return [targetId, sortedRequests[sortedRequests.length - 1]!];
    })
  );
}

function buildOrganizationsFromApi(
  organizations: Organization[],
  evaluationTargets: EvaluationTarget[],
  requests: EvaluationRequestModel[]
): OrganizationModel[] {
  const activeOrganizations = organizations.filter((organization) => organization.status !== "INACTIVE");
  const activeOrganizationIds = new Set(activeOrganizations.map((organization) => organization.id));
  const activeEvaluationTargets = evaluationTargets.filter(
    (target) => activeOrganizationIds.has(target.organizationId) && target.status !== "INACTIVE" && target.status !== "DELETED"
  );
  const targetsByOrganizationId = new Map<number, EvaluationTarget[]>();
  const latestRequestByTargetId = buildLatestRequestByTargetId(requests);

  for (const target of activeEvaluationTargets) {
    const currentTargets = targetsByOrganizationId.get(target.organizationId) ?? [];
    currentTargets.push(target);
    targetsByOrganizationId.set(target.organizationId, currentTargets);
  }

  return activeOrganizations
    .map((organization): OrganizationModel => {
      const targets = targetsByOrganizationId.get(organization.id) ?? [];
      const evaluationTargetModels = targets.map((target): EvaluationTargetModel => {
        const latestRequest = latestRequestByTargetId.get(target.id);

        return {
          id: target.id,
          name: target.name,
          targetType: target.targetType,
          accessUrl: target.accessUrl,
          faviconUrl: target.faviconUrl ?? null,
          status: latestRequest?.status ?? target.status,
          createdAt: target.createdAt
        };
      });
      const latestRequest = evaluationTargetModels
        .map((target) => latestRequestByTargetId.get(target.id))
        .filter((request): request is EvaluationRequestModel => request !== undefined)
        .sort(compareByUpdatedAt);
      const latestOrganizationRequest = latestRequest[latestRequest.length - 1];

      return {
        id: organization.id,
        name: organization.name,
        systemManaged: organization.systemManaged,
        description: organization.description ?? "",
        status: latestOrganizationRequest?.status ?? organization.status,
        updatedAt: latestOrganizationRequest?.updatedAt ?? organization.updatedAt,
        evaluationTargets: evaluationTargetModels
      };
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function fetchEvaluationIssues(requestId: number, signal?: AbortSignal): Promise<EvaluationIssue[]> {
  return apiGet(
    `/results/requests/${requestId}/issues`,
    createEvaluationIssuesResponseParser(requestId),
    signal
  );
}

export async function fetchEvaluationCaptureMetadata(
  requestId: number,
  signal?: AbortSignal
): Promise<EvaluationCaptureMetadata | null> {
  const metadataParser = createEvaluationCaptureMetadataParser(requestId);
  return apiRequest(
    `/results/requests/${requestId}/capture-metadata`,
    (value, path) => (value === null ? null : metadataParser(value, path)),
    {
      cache: "no-store",
      signal,
      optionalStatuses: [404]
    }
  );
}

export async function createLiveReportSession(
  requestId: number,
  signal?: AbortSignal
): Promise<LiveReportSession | null> {
  return apiRequest(
    `/results/requests/${requestId}/live-session`,
    (value, path) => (value === null ? null : parseLiveReportSessionResponse(value, path)),
    {
      method: "POST",
      signal,
      optionalStatuses: [404, 409, 501]
    }
  );
}

export async function renewLiveReportSession(
  requestId: number,
  sessionId: string,
  signal?: AbortSignal
): Promise<LiveReportSession> {
  return apiRequest(
    `/results/requests/${requestId}/live-session/${encodeURIComponent(sessionId)}/renew`,
    parseLiveReportSessionResponse,
    {
      method: "POST",
      signal
    }
  );
}

function getSyntheticAnalysisId(requestId: number, module: string): number {
  const moduleIndexMap: Record<string, number> = {
    rule_based: 1,
    text_difficulty: 2,
    text_suggestions: 3,
    cv_visual: 4
  };

  return -(requestId * 10 + (moduleIndexMap[module] ?? 9));
}

function moduleToAnalyzerType(module: string): AnalysisResult["analyzerType"] {
  const normalizedModule = module.toLowerCase();
  if (normalizedModule.includes("rule")) {
    return "RULE_BASED";
  }
  if (normalizedModule.includes("cv") || normalizedModule.includes("visual")) {
    return "CV_VISION";
  }
  return "AI_TEXT";
}

function issueSeverityToUiSeverity(severity: EvaluationIssue["severity"]): IssueResultModel["severity"] {
  if (severity === "CRITICAL") {
    return "CRITICAL";
  }
  if (severity === "SERIOUS") {
    return "HIGH";
  }
  if (severity === "MODERATE") {
    return "MEDIUM";
  }
  return "LOW";
}

function issueIdToNumber(issue: EvaluationIssue, index: number): number {
  if (typeof issue.id === "number") {
    return issue.id;
  }

  const parsed = Number.parseInt(issue.id, 10);
  return Number.isFinite(parsed) ? parsed : issue.requestId * 10000 + index + 1;
}

function buildIssueViewModels(
  evaluationIssues: EvaluationIssue[],
  requestById: Map<number, EvaluationRequestModel>
): { analysisResults: AnalysisResult[]; issueResults: IssueResultModel[] } {
  const analysisResultById = new Map<number, AnalysisResult>();
  const issueResults = evaluationIssues.map((issue, index): IssueResultModel => {
    const request = requestById.get(issue.requestId);
    const timestamp = issue.createdAt ?? request?.updatedAt ?? "";
    const analysisResultId = getSyntheticAnalysisId(issue.requestId, issue.module);

    if (!analysisResultById.has(analysisResultId)) {
      analysisResultById.set(analysisResultId, {
        id: analysisResultId,
        evaluationRequestId: issue.requestId,
        analyzerType: moduleToAnalyzerType(issue.module),
        status: "SUCCESS",
        summary: "",
        startedAt: null,
        completedAt: timestamp || null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    const description = issue.description?.trim() ?? "";
    const recommendation = issue.recommendation?.trim() ?? "";
    const message =
      recommendation.length > 0 && !description.includes(recommendation)
        ? `${description}\n\n권장사항: ${recommendation}`
        : description;

    return {
      id: issueIdToNumber(issue, index),
      analysisResultId,
      issueCode: issue.wcagCode ?? issue.module,
      issueTitle: issue.title,
      severity: issueSeverityToUiSeverity(issue.severity),
      locationPath: issue.selector ?? "",
      locator: issue.locator ?? null,
      message,
      recommendation: issue.recommendation ?? null,
      resolved: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  });

  return {
    analysisResults: [...analysisResultById.values()],
    issueResults
  };
}

export async function fetchEvaluationIssueViewModels(
  request: EvaluationRequestModel,
  signal?: AbortSignal
): Promise<{ analysisResults: AnalysisResult[]; issueResults: IssueResultModel[] }> {
  const evaluationIssues = await fetchEvaluationIssues(request.id, signal);
  return buildIssueViewModels(evaluationIssues, new Map([[request.id, request]]));
}

export async function createOrganizationModel(
  input: {
    name: string;
    description: string;
    attemptId: string;
  },
  signal?: AbortSignal
): Promise<Organization> {
  const created = await apiRequest("/organizations", parseOrganizationResponse, {
    method: "POST",
    headers: { "Idempotency-Key": input.attemptId },
    body: {
      name: input.name,
      description: input.description,
      type: "ETC"
    },
    signal
  });
  return created;
}

export async function updateOrganizationModel({
  projectId,
  name,
  description
}: {
  projectId: number;
  name: string;
  description: string;
}): Promise<void> {
  await apiRequest(`/organizations/${projectId}`, createOrganizationResponseParser(projectId), {
    method: "PATCH",
    body: {
      name,
      description
    }
  });
}

export async function deleteOrganizationModel(projectId: number): Promise<void> {
  await apiRequest(`/organizations/${projectId}/deactivate`, parseVoidResponse, {
    method: "PATCH"
  });
}

export async function createEvaluationTargetModel({
  projectId,
  name,
  accessUrl
}: CreateEvaluationTargetInput, signal?: AbortSignal): Promise<EvaluationTarget> {
  const createdTarget = await apiRequest(
    `/organizations/${projectId}/evaluation-targets`,
    createEvaluationTargetResponseParser({
      expectedOrganizationId: projectId,
      expectedName: name,
      expectedAccessUrl: accessUrl,
      expectedTargetType: "WEB",
      expectedStatus: "ACTIVE",
      strictAccessUrl: true
    }),
    {
      method: "POST",
      body: {
        name,
        accessUrl
      },
      signal
    }
  );
  return createdTarget;
}

export async function fetchEvaluationTargetsForOrganization(
  organizationId: number,
  signal?: AbortSignal
): Promise<EvaluationTarget[]> {
  return apiGet(
    `/organizations/${organizationId}/evaluation-targets`,
    createEvaluationTargetsResponseParser(organizationId),
    signal
  );
}

export async function fetchEvaluationRequests(
  signal?: AbortSignal
): Promise<EvaluationRequestModel[]> {
  return apiGet("/requests", parseEvaluationRequestsResponse, signal);
}

export async function deleteEvaluationTargetModel({
  siteId
}: {
  projectId: number;
  siteId: number;
}): Promise<void> {
  await apiRequest(`/targets/${siteId}/delete`, parseVoidResponse, {
    method: "PATCH"
  });
}

export async function requestEvaluationTargetRescan(
  targetId: number,
  signal?: AbortSignal
): Promise<number | null> {
  const response = await apiRequest(
    "/requests",
    createEvaluationRequestResponseParser({ expectedTargetId: targetId }),
    {
    method: "POST",
    body: {
      evaluationTargetId: targetId,
      requestNote: "다시 스캔 요청"
    },
    signal
    }
  );
  return response.id;
}

export async function startUrlEvaluation(url: string, signal?: AbortSignal): Promise<EvaluationRequestModel> {
  const evaluationRequest = await apiRequest(
    "/requests/evaluate",
    parseEvaluationRequestResponse,
    {
    method: "POST",
    body: { url },
    signal
    }
  );
  return evaluationRequest;
}

export async function fetchEvaluationRequest(
  requestId: number,
  signal?: AbortSignal
): Promise<EvaluationRequestModel> {
  return apiRequest(
    `/requests/${requestId}`,
    createEvaluationRequestResponseParser({ expectedId: requestId }),
    { cache: "no-store", signal }
  );
}

export async function fetchEvaluationTarget(targetId: number, signal?: AbortSignal): Promise<EvaluationTarget> {
  return apiRequest(
    `/targets/${targetId}`,
    createEvaluationTargetResponseParser({ expectedId: targetId }),
    { signal }
  );
}

export async function fetchDashboardViewModel(signal?: AbortSignal): Promise<DashboardViewModel> {
  const overview = await apiGet("/dashboard/overview", parseDashboardOverviewResponse, signal);
  const organizations = overview.organizations.map(
    ({ evaluationTargets: _evaluationTargets, ...organization }) => organization
  );
  const evaluationTargets = overview.organizations.flatMap(
    (organization) => organization.evaluationTargets
  );
  const activeOrganizationIds = new Set(
    organizations
      .filter((organization) => organization.status !== "INACTIVE")
      .map((organization) => organization.id)
  );
  const activeEvaluationTargetIds = new Set(
    evaluationTargets
      .filter(
        (target) =>
          activeOrganizationIds.has(target.organizationId) &&
          target.status !== "INACTIVE" &&
          target.status !== "DELETED"
      )
      .map((target) => target.id)
  );
  const visibleRequests = overview.evaluationRequests.filter((request) =>
    activeEvaluationTargetIds.has(request.evaluationTargetId)
  );
  const visibleRequestIds = new Set(visibleRequests.map((request) => request.id));

  return {
    organizations: buildOrganizationsFromApi(
      organizations,
      evaluationTargets,
      visibleRequests
    ),
    evaluationRequests: visibleRequests,
    resultSummaries: overview.resultSummaries.filter((summary) =>
      visibleRequestIds.has(summary.requestId)
    ),
    latestIssueCounts: overview.latestIssueCounts.filter(
      (statistics) =>
        activeEvaluationTargetIds.has(statistics.evaluationTargetId) &&
        visibleRequestIds.has(statistics.requestId)
    ),
    scoreResults: overview.scoreResults.filter((scoreResult) =>
      visibleRequestIds.has(scoreResult.evaluationRequestId)
    )
  };
}
