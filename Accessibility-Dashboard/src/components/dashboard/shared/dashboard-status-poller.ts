import { fetchEvaluationStatuses } from "@/services/analysis-protocol-api";
import { createRequestDeadline } from "@/services/async-cancellation";
import { fetchEvaluationRequest, isAbortError } from "@/services/backend-api";
import type { DashboardViewModel, EvaluationRequestModel } from "@/types/accessibility-domain";
import { failedPoll, type RequestPollObservation } from "./request-poll-policy";
import type { LoadDashboard } from "./use-dashboard-data";

type StatusPollerOptions = {
  activeEvaluationRequestIds: number[];
  observations: Map<number, RequestPollObservation>;
  getDashboard: () => DashboardViewModel | null;
  signal: AbortSignal;
  timeoutMs: number;
  loadDashboard: LoadDashboard;
  trackEvaluationRequest: (request: EvaluationRequestModel) => void;
  forgetRequest: (id: number) => void;
  updatePausedCount: () => void;
};

// Active-request transport is loaded only while there are requests to track.
export function createDashboardStatusPoller({
  activeEvaluationRequestIds, observations, getDashboard, signal, timeoutMs,
  loadDashboard, trackEvaluationRequest, forgetRequest, updatePausedCount
}: StatusPollerOptions) {
  const inFlight = new Set<number>();
  let activeBatches = 0;
  let overviewRefresh: Promise<DashboardViewModel | null> | null = null;

  const refreshOverview = () => {
    if (overviewRefresh) return overviewRefresh;
    overviewRefresh = loadDashboard({
      background: true,
      refreshAfterInFlight: true,
      signal
    }).finally(() => { overviewRefresh = null; });
    return overviewRefresh;
  };

  const recordFailure = (id: number) => {
    observations.set(id, failedPoll(observations.get(id), Date.now()));
    updatePausedCount();
  };
  const pollBatch = async (ids: number[]) => {
    activeBatches++;
    ids.forEach(id => inFlight.add(id));
    const deadline = createRequestDeadline({ signal, timeoutMs });
    try {
      const entries = getDashboard()?.analysisProtocolVersion === 1
        ? await fetchEvaluationStatuses(ids, deadline.controller.signal)
        : [{ id: ids[0], outcome: "FOUND" as const, request: await fetchEvaluationRequest(ids[0], deadline.controller.signal) }];
      if (signal.aborted) return;
      let needsOverview = false;
      for (const entry of entries) {
        const request = entry.request;
        if (entry.outcome === "REMOVED") {
          observations.set(entry.id, { failures: 0, firstFailureAt: 0, lastAttemptAt: Date.now(), nextAttemptAt: Infinity, paused: true, removed: true });
          forgetRequest(entry.id);
          needsOverview = true;
        } else if (!request) {
          recordFailure(entry.id);
          needsOverview = true;
        } else {
          // Apply each completed response immediately, independent of slow peers.
          trackEvaluationRequest(request);
          const targetVisible = getDashboard()?.organizations.some(organization => organization.evaluationTargets.some(target => target.id === request.evaluationTargetId));
          observations.set(entry.id, { failures: 0, firstFailureAt: 0, lastAttemptAt: Date.now(), nextAttemptAt: 0, paused: false });
          needsOverview ||= !targetVisible || request.status === "COMPLETED" || request.status === "FAILED";
        }
      }
      updatePausedCount();
      if (needsOverview) void refreshOverview();
    } catch (error) {
      if (!signal.aborted && (deadline.didTimeout() || !isAbortError(error))) {
        ids.forEach(recordFailure);
        void refreshOverview();
      }
    } finally {
      deadline.dispose();
      ids.forEach(id => inFlight.delete(id));
      activeBatches--;
    }
  };
  const pollActiveRequestStatuses = () => {
    if (signal.aborted || document.visibilityState === "hidden") return;
    const now = Date.now();
    const due = activeEvaluationRequestIds.filter(id => {
      const observation = observations.get(id);
      return !inFlight.has(id) && !observation?.paused && (observation?.nextAttemptAt ?? 0) <= now;
    }).sort((a, b) => (observations.get(a)?.lastAttemptAt ?? 0) - (observations.get(b)?.lastAttemptAt ?? 0));
    const batchSize = getDashboard()?.analysisProtocolVersion === 1 ? 100 : 1;
    // Limit concurrent transports, not just the number of IDs in each call.
    for (let start = 0; start < due.length && activeBatches < 4; start += batchSize) void pollBatch(due.slice(start, start + batchSize));
  };

  return pollActiveRequestStatuses;
}
