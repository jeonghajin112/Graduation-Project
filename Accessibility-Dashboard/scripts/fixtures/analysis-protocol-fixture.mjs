/**
 * Route-mock helpers that answer the backend's keyed analysis endpoints the
 * way ap-backend does (EvaluationRequestController, AnalysisSubmissionService).
 * Each script keeps its own request table; these helpers only shape replies.
 */

export const ACTIVE_REQUEST_STATUSES = new Set(["PENDING", "IN_PROGRESS"]);

/** `/api/requests/statuses?ids=1,2` → the requested ids, in order. */
export function readStatusIds(url) {
  return (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).map(Number);
}

/**
 * One entry per requested id. `findRequest(id)` returns the request, null when
 * it does not exist, or "REMOVED" when its page or project was deleted.
 */
export function statusEntries(ids, findRequest) {
  return ids.map((id) => {
    const request = findRequest(id);
    if (request === "REMOVED") return { id, outcome: "REMOVED", request: null };
    return request ? { id, outcome: "FOUND", request } : { id, outcome: "NOT_FOUND", request: null };
  });
}

/** `/api/requests/active?targetId=101` → that page's pending or running requests. */
export function activeRequestsForTarget(requests, url) {
  const targetId = Number(url.searchParams.get("targetId"));
  return requests.filter(
    (request) => request.evaluationTargetId === targetId && ACTIVE_REQUEST_STATUSES.has(request.status)
  );
}

export function idempotencyKey(route) {
  return route.request().headers()["idempotency-key"] ?? null;
}

/** `/api/requests/attempts/{key}` → the key, or null for any other path. */
export function readAttemptKey(pathname) {
  const match = /^\/api\/requests\/attempts\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Server-side idempotency: a repeated key returns the request it created
 * first instead of creating another one.
 */
export function createAnalysisAttempts() {
  const requestsByKey = new Map();
  return {
    find: (key) => requestsByKey.get(key) ?? null,
    remember: (key, request) => {
      if (key) requestsByKey.set(key, request);
      return request;
    },
    keys: () => [...requestsByKey.keys()]
  };
}
