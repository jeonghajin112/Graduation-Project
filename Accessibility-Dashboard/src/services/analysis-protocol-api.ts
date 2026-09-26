import { apiRequest } from "./backend-api";
import { createEvaluationRequestResponseParser, parseEvaluationRequestResponse,
  parseEvaluationRequestsResponse, parseArray, readFields, parsePositiveInteger,
  parseEnumValue, failContract, type ApiResponseParser } from "./api-contracts";
import type { EvaluationRequestModel } from "@/types/accessibility-domain";

export type EvaluationStatusEntry = { id: number; outcome: "FOUND" | "NOT_FOUND" | "REMOVED"; request: EvaluationRequestModel | null };
export function createEvaluationStatusesParser(ids: readonly number[]): ApiResponseParser<EvaluationStatusEntry[]> {
  return (value, path) => {
    const entries = parseArray(value, path, (entry, entryPath): EvaluationStatusEntry => {
      const fields = readFields(entry, entryPath);
      const id = fields.required("id", parsePositiveInteger);
      const outcome = fields.required("outcome", (field, fieldPath) => parseEnumValue(field, fieldPath, ["FOUND", "NOT_FOUND", "REMOVED"] as const));
      const request = fields.required("request", (field, fieldPath) => field === null ? null : createEvaluationRequestResponseParser({ expectedId: id })(field, fieldPath));
      if ((outcome === "FOUND") !== (request !== null)) failContract(entry, entryPath, "조회 상태와 일치하는 요청");
      return { id, outcome, request };
    });
    if (entries.length !== ids.length || new Set(entries.map(entry => entry.id)).size !== ids.length || entries.some(entry => !ids.includes(entry.id))) {
      failContract(value, path, "누락·중복 없이 조회한 ID와 일치하는 상태 목록");
    }
    return entries;
  };
}

export function fetchAnalysisAttempt(attemptId: string, signal?: AbortSignal): Promise<EvaluationRequestModel | null> {
  return apiRequest(`/requests/attempts/${encodeURIComponent(attemptId)}`,
    (value, path) => value === null ? null : parseEvaluationRequestResponse(value, path), { cache: "no-store", signal });
}

export function fetchActiveTargetRequests(targetId: number, signal?: AbortSignal): Promise<EvaluationRequestModel[]> {
  return apiRequest(`/requests/active?targetId=${targetId}`, (value, path) => {
    const requests = parseEvaluationRequestsResponse(value, path);
    for (const request of requests) createEvaluationRequestResponseParser({ expectedTargetId: targetId })(request, path);
    return requests;
  }, { cache: "no-store", signal });
}

export function fetchEvaluationStatuses(ids: readonly number[], signal?: AbortSignal) {
  return apiRequest(`/requests/statuses?ids=${ids.join(",")}`, createEvaluationStatusesParser(ids), { cache: "no-store", signal });
}

export async function requestEvaluationTargetRescan(
  targetId: number,
  signal?: AbortSignal,
  attemptId?: string
): Promise<number | null> {
  const response = await apiRequest(
    "/requests",
    createEvaluationRequestResponseParser({ expectedTargetId: targetId }),
    {
    method: "POST",
    headers: attemptId ? { "Idempotency-Key": attemptId } : undefined,
    body: {
      evaluationTargetId: targetId,
      requestNote: "다시 스캔 요청"
    },
    signal
    }
  );
  return response.id;
}

export async function startUrlEvaluation(url: string, signal?: AbortSignal, attemptId?: string): Promise<EvaluationRequestModel> {
  const evaluationRequest = await apiRequest(
    "/requests/evaluate",
    parseEvaluationRequestResponse,
    {
    method: "POST",
    body: { url },
    headers: attemptId ? { "Idempotency-Key": attemptId } : undefined,
    signal
    }
  );
  return evaluationRequest;
}

