import { buildApiUrl } from "@/config/api";
import type {
  AnalysisResult,
  DashboardViewModel,
  CreateEvaluationTargetInput,
  EvaluationArtifact,
  EvaluationIssue,
  EvaluationRequestModel,
  EvaluationTarget,
  EvaluationTargetModel,
  EvaluationResultSummary,
  ImprovementGuide,
  IssueResultModel,
  Organization,
  OrganizationModel,
  ScoreResult
} from "@/types/accessibility-domain";

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  message?: string | null;
  error?: string | null;
};

type ApiRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type ApiRequestOptions = {
  method?: ApiRequestMethod;
  body?: unknown;
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
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isApiEnvelope<T = unknown>(value: unknown): value is ApiEnvelope<T> {
  return (
    isRecord(value) &&
    typeof value.success === "boolean" &&
    (!("message" in value) || value.message === null || typeof value.message === "string") &&
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

async function apiRequest<T = unknown>(
  path: string,
  { method = "GET", body, signal, optionalStatuses = [] }: ApiRequestOptions = {}
): Promise<T> {
  const headers: HeadersInit = {
    Accept: "application/json"
  };
  const requestInit: RequestInit = {
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
      return null as T;
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

  if (isApiEnvelope<T>(payload)) {
    if (!payload.success) {
      throw new ApiRequestError({
        method,
        path,
        payload,
        status: response.status,
        url,
        message: getErrorMessage(payload, "API request failed.")
      });
    }

    return ("data" in payload ? payload.data : null) as T;
  }

  return payload as T;
}

async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(path, { signal });
}

// ── 대시보드 로딩 최적화용 인메모리 캐시 ─────────────────────────────────────
// 대시보드는 5초 간격으로 폴리링되므로, 자주 바뀌지 않는 데이터를 캐시해서
// 매 폴리링마다 발생하던 N+1 API 호출을 줄인다.
//
// - 디렉터리(조직/평가 대상): CRUD 시 명시적으로 무효화 + TTL 안전망
//   (백엔드 측 변경, 예: AI 모듈이 직접 생성한 조직/대상도 곧 반영되도록)
// - 요청 결과(summary/issues/score): COMPLETED 요청의 결과는 불변에 가깝고
//   UI에서 재스캔하면 항상 새 request가 생성되므로 requestId 키로 캐시.
//   TTL은 외부(CLI) 재실행 같은 드문 케이스를 위한 안전망.

const DIRECTORY_TTL_MS = 15_000;
const REQUEST_RESULT_TTL_MS = 60_000;
const REQUEST_RESULT_CACHE_LIMIT = 200;

function isFreshCacheTimestamp(fetchedAt: number, ttlMs: number): boolean {
  const age = Date.now() - fetchedAt;
  // Wall clocks can move backwards (NTP/manual changes). A negative age must
  // not turn an old snapshot into an indefinitely fresh cache hit.
  return age >= 0 && age < ttlMs;
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function waitForSharedPromiseOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

type DirectorySnapshot = {
  organizations: Organization[];
  evaluationTargets: EvaluationTarget[];
  fetchedAt: number;
};

type DirectorySnapshotInFlight = {
  generation: number;
  promise: Promise<DirectorySnapshot>;
};

type RequestResultBundle = {
  summary: EvaluationResultSummary;
  issues: EvaluationIssue[];
  scoreResult: ScoreResult | null;
  fetchedAt: number;
};

let directorySnapshotCache: DirectorySnapshot | null = null;
let directorySnapshotGeneration = 0;
let directorySnapshotInFlight: DirectorySnapshotInFlight | null = null;
const requestResultCache = new Map<number, RequestResultBundle>();
const requestResultInFlight = new Map<number, Promise<RequestResultBundle>>();

function invalidateDashboardCaches(): void {
  directorySnapshotGeneration += 1;
  directorySnapshotCache = null;
}

async function fetchDirectorySnapshot(signal?: AbortSignal): Promise<DirectorySnapshot> {
  const generation = directorySnapshotGeneration;
  if (
    directorySnapshotCache &&
    isFreshCacheTimestamp(directorySnapshotCache.fetchedAt, DIRECTORY_TTL_MS)
  ) {
    return directorySnapshotCache;
  }

  // Reuse an in-flight snapshot only when the caller's signal is still live.
  // Strict Mode aborts the first effect's fetch; a remounted effect must not
  // inherit that aborted promise or the dashboard boot overlay never clears.
  if (
    directorySnapshotInFlight?.generation === generation &&
    !signal?.aborted
  ) {
    try {
      return await waitForSharedPromiseOrAbort(directorySnapshotInFlight.promise, signal);
    } catch (error) {
      if (!isAbortError(error) || signal?.aborted) {
        throw error;
      }
      // Previous shared request was aborted by another caller; fall through and retry.
    }
  }

  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const snapshotPromise = (async () => {
    const organizations = await fetchOrganizations(signal);
    const evaluationTargets = (
      await Promise.all(organizations.map((organization) => fetchEvaluationTargets(organization.id, signal)))
    ).flat();
    const snapshot: DirectorySnapshot = { organizations, evaluationTargets, fetchedAt: Date.now() };
    if (generation === directorySnapshotGeneration) {
      directorySnapshotCache = snapshot;
    }
    return snapshot;
  })();

  directorySnapshotInFlight = { generation, promise: snapshotPromise };

  try {
    return await snapshotPromise;
  } finally {
    if (directorySnapshotInFlight?.promise === snapshotPromise) {
      directorySnapshotInFlight = null;
    }
  }
}

function pruneRequestResultCache(): void {
  while (requestResultCache.size > REQUEST_RESULT_CACHE_LIMIT) {
    const oldestKey = requestResultCache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    requestResultCache.delete(oldestKey);
  }
}

async function fetchRequestResultBundle(
  request: EvaluationRequestModel,
  signal?: AbortSignal
): Promise<RequestResultBundle> {
  const cached = requestResultCache.get(request.id);
  if (cached && isFreshCacheTimestamp(cached.fetchedAt, REQUEST_RESULT_TTL_MS)) {
    // LRU 순서 갱신 (Map은 삽입 순서를 유지하므로 재삽입으로 최신화)
    requestResultCache.delete(request.id);
    requestResultCache.set(request.id, cached);
    return cached;
  }

  const inFlight = requestResultInFlight.get(request.id);
  if (inFlight) {
    try {
      return await waitForSharedPromiseOrAbort(inFlight, signal);
    } catch (error) {
      if (!isAbortError(error) || signal?.aborted) {
        throw error;
      }
      // The shared request belonged to a caller that was cancelled. This
      // caller is still live, so retry with its own signal.
    }
  }

  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const bundlePromise = (async (): Promise<RequestResultBundle> => {
    const [summary, issues] = await Promise.all([
      fetchEvaluationResultSummary(request.id, signal),
      fetchEvaluationIssues(request.id, signal)
    ]);
    const { scoreResult, cacheable: isScoreResultCacheable } =
      await fetchScoreResultSafely(summary.requestId, cached !== undefined, signal);
    const bundle: RequestResultBundle = { summary, issues, scoreResult, fetchedAt: Date.now() };
    if (isScoreResultCacheable) {
      requestResultCache.set(request.id, bundle);
      pruneRequestResultCache();
    }
    return bundle;
  })();

  requestResultInFlight.set(request.id, bundlePromise);

  try {
    return await bundlePromise;
  } finally {
    if (requestResultInFlight.get(request.id) === bundlePromise) {
      requestResultInFlight.delete(request.id);
    }
  }
}

async function fetchRequestResultBundleSafely(
  request: EvaluationRequestModel,
  signal?: AbortSignal
): Promise<RequestResultBundle | null> {
  const staleBundle = requestResultCache.get(request.id) ?? null;

  try {
    return await fetchRequestResultBundle(request, signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    // Keep the last materialized result when a refresh fails. Its timestamp is
    // intentionally not renewed, so later dashboard polls continue trying to
    // recover the fresh bundle instead of treating this fallback as a new hit.
    if (staleBundle) {
      console.warn(`Using stale result bundle for request ${request.id}.`, error);
      return staleBundle;
    }

    // A completed request can temporarily or permanently lack its summary.
    // Isolate that record so one broken historical result cannot make the
    // organization directory and every other valid result unavailable.
    console.warn(`Skipping unavailable result bundle for request ${request.id}.`, error);
    return null;
  }
}


function compareByUpdatedAt(left: EvaluationRequestModel, right: EvaluationRequestModel): number {
  return Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
}

function fetchOrganizations(signal?: AbortSignal): Promise<Organization[]> {
  return apiGet<Organization[]>("/organizations", signal);
}

function fetchEvaluationTargets(organizationId: number, signal?: AbortSignal): Promise<EvaluationTarget[]> {
  return apiGet<EvaluationTarget[]>(`/organizations/${organizationId}/evaluation-targets`, signal);
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
        type: organization.type,
        homepageUrl: organization.homepageUrl ?? "",
        description: organization.description ?? "",
        status: latestOrganizationRequest?.status ?? organization.status,
        createdAt: organization.createdAt,
        updatedAt: latestOrganizationRequest?.updatedAt ?? organization.updatedAt,
        evaluationTargets: evaluationTargetModels
      };
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function fetchEvaluationResultSummary(requestId: number, signal?: AbortSignal): Promise<EvaluationResultSummary> {
  return apiGet<EvaluationResultSummary>(`/results/requests/${requestId}/summary`, signal);
}

function fetchEvaluationIssues(requestId: number, signal?: AbortSignal): Promise<EvaluationIssue[]> {
  return apiGet<EvaluationIssue[]>(`/results/requests/${requestId}/issues`, signal);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseEvaluationArtifact(value: unknown, expectedRequestId: number): EvaluationArtifact {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) <= 0 ||
    !Number.isSafeInteger(value.requestId) ||
    (value.requestId as number) <= 0 ||
    value.requestId !== expectedRequestId ||
    typeof value.requestedUrl !== "string" ||
    typeof value.finalUrl !== "string" ||
    typeof value.capturedAt !== "string" ||
    !isPositiveFiniteNumber(value.viewportWidthCssPx) ||
    !isPositiveFiniteNumber(value.viewportHeightCssPx) ||
    !isPositiveFiniteNumber(value.deviceScaleFactor) ||
    !isPositiveFiniteNumber(value.pageWidthCssPx) ||
    !isPositiveFiniteNumber(value.pageHeightCssPx) ||
    value.captureMode !== "DOM_REPLAY" ||
    typeof value.contentUrl !== "string" ||
    value.contentType !== "text/html" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(value.sha256) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    ![
      `/results/artifacts/${value.id}/content`,
      `/api/results/artifacts/${value.id}/content`
    ].includes(value.contentUrl)
  ) {
    throw new Error("페이지 재현 화면 응답 형식이 올바르지 않습니다.");
  }

  return value as unknown as EvaluationArtifact;
}

export async function fetchEvaluationArtifact(
  requestId: number,
  signal?: AbortSignal
): Promise<EvaluationArtifact | null> {
  const response = await apiRequest<unknown>(`/results/requests/${requestId}/artifact`, {
    signal,
    optionalStatuses: [404]
  });
  return response === null ? null : parseEvaluationArtifact(response, requestId);
}

export function getEvaluationArtifactContentUrl(contentUrl: string): string {
  const apiRelativePath = contentUrl.startsWith("/api/") ? contentUrl.slice(4) : contentUrl;
  return buildApiUrl(apiRelativePath);
}

function fetchScoreResult(requestId: number, signal?: AbortSignal): Promise<ScoreResult> {
  return apiGet<ScoreResult>(`/scores/requests/${requestId}`, signal);
}

async function fetchScoreResultSafely(
  requestId: number,
  hasStaleBundle: boolean,
  signal?: AbortSignal
): Promise<{ scoreResult: ScoreResult | null; cacheable: boolean }> {
  try {
    return {
      scoreResult: await fetchScoreResult(requestId, signal),
      cacheable: true
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.warn(`Failed to load score result for request ${requestId}.`, error);
    if (hasStaleBundle) {
      // A transient score-detail failure must not replace a previously complete
      // bundle with a summary-derived score whose category values are all zero.
      // Let the outer bundle fallback retain the complete stale value instead.
      throw error;
    }

    return {
      // Keep the independently loaded summary and issues, but do not turn an
      // unavailable category breakdown into a complete-looking ScoreResult.
      // The missing detail stays uncached so the next poll retries it.
      scoreResult: null,
      cacheable: false
    };
  }
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

    const description = issue.description.trim();
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

export async function createOrganizationModel(
  input: {
    name: string;
    description: string;
  },
  signal?: AbortSignal
): Promise<Organization> {
  const created = await apiRequest<Organization>("/organizations", {
    method: "POST",
    body: {
      ...input,
      type: "ETC"
    },
    signal
  });
  invalidateDashboardCaches();
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
  await apiRequest(`/organizations/${projectId}`, {
    method: "PATCH",
    body: {
      name,
      description
    }
  });
  invalidateDashboardCaches();
}

export async function deleteOrganizationModel(projectId: number): Promise<void> {
  await apiRequest(`/organizations/${projectId}/deactivate`, {
    method: "PATCH"
  });
  invalidateDashboardCaches();
}

export async function createEvaluationTargetModel({
  projectId,
  name,
  accessUrl
}: CreateEvaluationTargetInput, signal?: AbortSignal): Promise<EvaluationTarget> {
  const createdTarget = await apiRequest<EvaluationTarget>(`/organizations/${projectId}/evaluation-targets`, {
    method: "POST",
    body: {
      name,
      accessUrl
    },
    signal
  });
  invalidateDashboardCaches();
  return createdTarget;
}

export async function deleteEvaluationTargetModel({
  siteId
}: {
  projectId: number;
  siteId: number;
}): Promise<void> {
  await apiRequest(`/targets/${siteId}/delete`, {
    method: "PATCH"
  });
  invalidateDashboardCaches();
}

export async function requestEvaluationTargetRescan(
  targetId: number,
  signal?: AbortSignal
): Promise<number | null> {
  const response = await apiRequest<EvaluationRequestModel>("/requests", {
    method: "POST",
    body: {
      evaluationTargetId: targetId,
      requestNote: "다시 스캔 요청"
    },
    signal
  });
  return typeof response?.id === "number" ? response.id : null;
}

export async function startUrlEvaluation(url: string, signal?: AbortSignal): Promise<EvaluationRequestModel> {
  const evaluationRequest = await apiRequest<EvaluationRequestModel>("/requests/evaluate", {
    method: "POST",
    body: { url },
    signal
  });
  invalidateDashboardCaches();
  return evaluationRequest;
}

export async function fetchEvaluationRequest(
  requestId: number,
  signal?: AbortSignal
): Promise<EvaluationRequestModel> {
  return apiRequest<EvaluationRequestModel>(`/requests/${requestId}`, { signal });
}

export async function fetchEvaluationTarget(targetId: number, signal?: AbortSignal): Promise<EvaluationTarget> {
  return apiRequest<EvaluationTarget>(`/targets/${targetId}`, { signal });
}

export async function fetchDashboardViewModel(
  signal?: AbortSignal,
  forceDirectoryRefresh = false
): Promise<DashboardViewModel> {
  if (forceDirectoryRefresh) {
    invalidateDashboardCaches();
  }

  const [requests, directory] = await Promise.all([
    apiGet<EvaluationRequestModel[]>("/requests", signal),
    fetchDirectorySnapshot(signal)
  ]);
  const { organizations, evaluationTargets } = directory;
  const activeOrganizationIds = new Set(
    organizations.filter((organization) => organization.status !== "INACTIVE").map((organization) => organization.id)
  );
  const activeEvaluationTargetIds = new Set(
    evaluationTargets
      .filter(
        (target) =>
          activeOrganizationIds.has(target.organizationId) && target.status !== "INACTIVE" && target.status !== "DELETED"
      )
      .map((target) => target.id)
  );
  const visibleRequests = requests.filter((request) => activeEvaluationTargetIds.has(request.evaluationTargetId));
  const requestById = new Map(visibleRequests.map((request) => [request.id, request]));
  const completedRequests = visibleRequests.filter((request) => request.status === "COMPLETED");
  const resultBundles = (
    await Promise.all(
      completedRequests.map((request) => fetchRequestResultBundleSafely(request, signal))
    )
  ).filter((bundle): bundle is RequestResultBundle => bundle !== null);
  const resultSummaries = resultBundles.map((bundle) => bundle.summary);
  const evaluationIssues = resultBundles.flatMap((bundle) => bundle.issues);
  const scoreResults = resultBundles
    .map((bundle) => bundle.scoreResult)
    .filter((scoreResult): scoreResult is ScoreResult => scoreResult !== null);
  const issueViewModels = buildIssueViewModels(evaluationIssues, requestById);
  const improvementGuides: ImprovementGuide[] = [];

  return {
    organizations: buildOrganizationsFromApi(organizations, evaluationTargets, visibleRequests),
    evaluationRequests: visibleRequests,
    resultSummaries,
    evaluationIssues,
    analysisResults: issueViewModels.analysisResults,
    scoreResults,
    scoreDetails: [],
    issueResults: issueViewModels.issueResults,
    improvementGuides
  };
}
