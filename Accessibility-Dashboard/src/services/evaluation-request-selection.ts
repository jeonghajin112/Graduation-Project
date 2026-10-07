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

// Submission order is distinct from result/status recency: an old job may
// receive a late status update after a newer attempt has already failed.
// A just-accepted placeholder has no server submission time; the server's
// monotonically increasing ID then orders it instead of the browser clock.
export function selectLatestAnalysisAttempt(requests: readonly EvaluationRequestModel[]): EvaluationRequestModel | null {
  return requests.reduce<EvaluationRequestModel | null>((latest, request) => {
    if (!latest) return request;
    const left = Date.parse(request.requestedAt);
    const right = Date.parse(latest.requestedAt);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return request.id > latest.id ? request : latest;
    }
    return left > right || (left === right && request.id > latest.id) ? request : latest;
  }, null);
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

function sidebarPriority(request: EvaluationRequestModel): number {
  return request.status === "IN_PROGRESS" ? 2 : request.status === "PENDING" ? 1 : 0;
}

// True when `candidate` should represent its page instead of `current`: a
// running job first, then a queued one, then the latest submission, then the
// higher id. One pass over the history instead of sorting all of it.
function representsPageBefore(candidate: EvaluationRequestModel, current: EvaluationRequestModel): boolean {
  const byPriority = sidebarPriority(candidate) - sidebarPriority(current);
  if (byPriority !== 0) return byPriority > 0;
  const byTime = Date.parse(candidate.requestedAt) - Date.parse(current.requestedAt);
  if (byTime) return byTime > 0;
  return candidate.id > current.id;
}

/** The request each page shows in the sidebar: its running, queued or latest analysis. */
export function selectRepresentativeRequestByTarget(
  requests: readonly EvaluationRequestModel[]
): Map<number, EvaluationRequestModel> {
  const byTarget = new Map<number, EvaluationRequestModel>();
  for (const request of requests) {
    const current = byTarget.get(request.evaluationTargetId);
    if (!current || representsPageBefore(request, current)) byTarget.set(request.evaluationTargetId, request);
  }
  return byTarget;
}
