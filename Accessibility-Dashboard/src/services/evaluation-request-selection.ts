import type { EvaluationRequestModel } from "@/types/accessibility-domain";

function toComparableTimestamp(value: string): number {
  // API dates are validated at the boundary. In-memory recovery data can lack
  // one: rank it before dated requests and use the request ID to break ties.
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

export function compareEvaluationRequestRecency(
  left: EvaluationRequestModel,
  right: EvaluationRequestModel
): number {
  const leftTimestamp = toComparableTimestamp(left.updatedAt);
  const rightTimestamp = toComparableTimestamp(right.updatedAt);

  return leftTimestamp === rightTimestamp
    ? left.id - right.id
    : leftTimestamp - rightTimestamp;
}

export function selectLatestEvaluationRequest(
  requests: readonly EvaluationRequestModel[],
  eligibleRequestIds?: ReadonlySet<number>
): EvaluationRequestModel | null {
  let latestRequest: EvaluationRequestModel | null = null;

  for (const request of requests) {
    if (eligibleRequestIds && !eligibleRequestIds.has(request.id)) {
      continue;
    }

    if (!latestRequest || compareEvaluationRequestRecency(request, latestRequest) > 0) {
      latestRequest = request;
    }
  }

  return latestRequest;
}

export function buildLatestEvaluationRequestByTargetId(
  requests: readonly EvaluationRequestModel[],
  eligibleRequestIds?: ReadonlySet<number>
): Map<number, EvaluationRequestModel> {
  const latestRequestByTargetId = new Map<number, EvaluationRequestModel>();

  for (const request of requests) {
    if (eligibleRequestIds && !eligibleRequestIds.has(request.id)) {
      continue;
    }

    const current = latestRequestByTargetId.get(request.evaluationTargetId);
    if (!current || compareEvaluationRequestRecency(request, current) > 0) {
      latestRequestByTargetId.set(request.evaluationTargetId, request);
    }
  }

  return latestRequestByTargetId;
}
