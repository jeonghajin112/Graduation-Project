import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchDashboardViewModel,
  fetchEvaluationRequest,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";
import type { DashboardViewModel, EvaluationRequestModel } from "@/types/accessibility-domain";

type LoadDashboardOptions = {
  background?: boolean;
  awaitInFlight?: boolean;
  refreshAfterInFlight?: boolean;
  showLoading?: boolean;
  clearOnError?: boolean;
  signal?: AbortSignal;
};

export type LoadDashboard = (options?: LoadDashboardOptions) => Promise<DashboardViewModel | null>;
export type DirectoryRecoveryToken = symbol;

type DirectoryRecoveryLease = {
  token: DirectoryRecoveryToken;
  baselineOrganizations: DashboardViewModel["organizations"];
  baselineEvaluationRequests: DashboardViewModel["evaluationRequests"];
  baselineResultSummaries: DashboardViewModel["resultSummaries"];
  baselineLatestIssueCounts: DashboardViewModel["latestIssueCounts"];
  baselineScoreResults: DashboardViewModel["scoreResults"];
  incompleteSnapshotCount: number;
  protectionActive: boolean;
};

type DirectoryRecovery = {
  leases: Map<DirectoryRecoveryToken, DirectoryRecoveryLease>;
  lastConsistentData: DashboardViewModel | null;
};

type ActiveDashboardLoad = {
  cleanup: () => void;
  controller: AbortController;
  id: symbol;
  isBackground: boolean;
  managesLoading: boolean;
  promise: Promise<DashboardViewModel | null>;
};

const MAX_INCOMPLETE_RECOVERY_SNAPSHOTS = 4;
export const DASHBOARD_STATUS_POLL_INTERVAL_MS = 5_000;
export const DASHBOARD_STATUS_POLL_TIMEOUT_MS = 10_000;
export const DASHBOARD_OVERVIEW_TIMEOUT_MS = 15_000;
export const DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE =
  "대시보드를 불러오는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.";

function createDashboardSnapshotSignature(data: DashboardViewModel): string {
  // The aggregate response is already the UI's complete source of truth. A
  // stable serialized signature lets a successful poll clear a transient
  // error without replacing React state when none of that truth changed.
  return JSON.stringify(data);
}

function getRequestStatusProgress(status: string): number | null {
  switch (status) {
    case "PENDING":
      return 0;
    case "IN_PROGRESS":
    case "RUNNING":
      return 1;
    case "COMPLETED":
    case "FAILED":
      return 2;
    default:
      return null;
  }
}

function requestStatusHasNotRolledBack(baselineStatus: string, nextStatus: string): boolean {
  if (nextStatus === baselineStatus) {
    return true;
  }
  if (baselineStatus === "COMPLETED" || baselineStatus === "FAILED") {
    // Terminal states are not interchangeable. In particular, accepting a
    // COMPLETED -> FAILED snapshot would drop the materialized result bundle.
    return false;
  }

  const baselineProgress = getRequestStatusProgress(baselineStatus);
  const nextProgress = getRequestStatusProgress(nextStatus);
  if (baselineProgress === null || nextProgress === null) {
    // A backend can add a status before this client is upgraded. Fail closed
    // for transitions we cannot order. Equality was handled above.
    return false;
  }

  return nextProgress >= baselineProgress;
}

function requestHasNotRolledBack(
  baseline: DashboardViewModel["evaluationRequests"][number],
  next: DashboardViewModel["evaluationRequests"][number]
): boolean {
  const baselineUpdatedAt = Date.parse(baseline.updatedAt);
  const nextUpdatedAt = Date.parse(next.updatedAt);
  if (Number.isFinite(baselineUpdatedAt)) {
    if (!Number.isFinite(nextUpdatedAt) || nextUpdatedAt < baselineUpdatedAt) {
      return false;
    }
  }

  return requestStatusHasNotRolledBack(baseline.status, next.status);
}

type WaitForLoadResult =
  | { aborted: false; value: DashboardViewModel | null }
  | { aborted: true };

function waitForLoadOrAbort(
  promise: Promise<DashboardViewModel | null>,
  signal?: AbortSignal
): Promise<WaitForLoadResult> {
  if (!signal) {
    return promise.then((value) => ({ aborted: false, value }));
  }
  if (signal.aborted) {
    return Promise.resolve({ aborted: true });
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      resolve({ aborted: true });
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve({ aborted: false, value });
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function protectRecoverySnapshot(
  nextData: DashboardViewModel,
  recovery: DirectoryRecovery | null
): DashboardViewModel {
  if (!recovery || recovery.leases.size === 0) {
    return nextData;
  }

  const nextOrganizationsById = new Map(
    nextData.organizations.map((organization) => [organization.id, organization])
  );
  const nextRequestsById = new Map(
    nextData.evaluationRequests.map((request) => [request.id, request])
  );
  const nextResultSummaryRequestIds = new Set(
    nextData.resultSummaries.map((summary) => summary.requestId)
  );
  const nextLatestIssueCountRequestIds = new Set(
    nextData.latestIssueCounts.map((statistics) => statistics.requestId)
  );
  const nextScoreResultKeys = new Set(
    nextData.scoreResults.map(
      (scoreResult) => `${scoreResult.id}:${scoreResult.evaluationRequestId}`
    )
  );

  let hasIncompleteActiveLease = false;
  for (const lease of recovery.leases.values()) {
    if (!lease.protectionActive) {
      continue;
    }

    const isDirectoryComplete = lease.baselineOrganizations.every(
      (protectedOrganization) => {
        const nextOrganization = nextOrganizationsById.get(protectedOrganization.id);
        if (!nextOrganization) {
          return false;
        }

        const nextTargetIds = new Set(
          nextOrganization.evaluationTargets.map((target) => target.id)
        );
        return protectedOrganization.evaluationTargets.every((target) =>
          nextTargetIds.has(target.id)
        );
      }
    );
    const areBaselineRequestsComplete = lease.baselineEvaluationRequests.every(
      (baselineRequest) => {
        const nextRequest = nextRequestsById.get(baselineRequest.id);
        return nextRequest ? requestHasNotRolledBack(baselineRequest, nextRequest) : false;
      }
    );
    const areBaselineResultsComplete =
      lease.baselineResultSummaries.every((summary) =>
        nextResultSummaryRequestIds.has(summary.requestId)
      ) &&
      lease.baselineLatestIssueCounts.every((statistics) =>
        nextLatestIssueCountRequestIds.has(statistics.requestId)
      ) &&
      lease.baselineScoreResults.every((scoreResult) =>
        nextScoreResultKeys.has(`${scoreResult.id}:${scoreResult.evaluationRequestId}`)
      );

    if (isDirectoryComplete && areBaselineRequestsComplete && areBaselineResultsComplete) {
      lease.incompleteSnapshotCount = 0;
      continue;
    }

    lease.incompleteSnapshotCount += 1;
    if (lease.incompleteSnapshotCount >= MAX_INCOMPLETE_RECOVERY_SNAPSHOTS) {
      // A real concurrent deletion is indistinguishable from a long-lived
      // stale snapshot. Expire only this lease; newer overlapping mutations
      // retain their own bounded protection window.
      lease.protectionActive = false;
      continue;
    }

    hasIncompleteActiveLease = true;
  }

  if (!hasIncompleteActiveLease) {
    // A snapshot becomes the shared fallback only when every still-protected
    // lease accepts it. This prevents a complete older lease from replacing
    // the fallback while a newer overlapping lease still sees partial data.
    recovery.lastConsistentData = nextData;
    return nextData;
  }

  // Directory and request endpoints feed every downstream result filter. If
  // an existing organization, target, or request is missing (or rolls back)
  // during creation recovery, the whole derived view model is incomplete, not
  // just its organization tree.
  // Keep the most recent internally consistent snapshot until the directory
  // recovers or the bounded protection lease above expires.
  return recovery.lastConsistentData ?? nextData;
}

export function useDashboardData({
  onBootstrapComplete
}: {
  onBootstrapComplete?: () => void;
}) {
  const [dashboardData, setDashboardData] = useState<DashboardViewModel | null>(null);
  const [isDashboardLoading, setIsDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState("");
  const isBootstrappedRef = useRef(false);
  const dashboardDataRef = useRef<DashboardViewModel | null>(null);
  const dashboardSnapshotSignatureRef = useRef<string | null>(null);
  const activeLoadRef = useRef<ActiveDashboardLoad | null>(null);
  const directoryRecoveryRef = useRef<DirectoryRecovery | null>(null);
  // Confirmed POST/status responses remain visible while the overview catches up.
  const [trackedRequests, setTrackedRequests] = useState<Record<number, EvaluationRequestModel>>({});
  const trackEvaluationRequest = useCallback((request: EvaluationRequestModel) => {
    setTrackedRequests((current) => {
      const previous = current[request.id];
      if (previous && (!requestHasNotRolledBack(previous, request) ||
        JSON.stringify(previous) === JSON.stringify(request))) return current;
      return { ...current, [request.id]: request };
    });
  }, []);

  const beginDirectoryRecovery = useCallback((): DirectoryRecoveryToken => {
    const token = Symbol("directory-recovery");
    const lease: DirectoryRecoveryLease = {
      token,
      baselineOrganizations: dashboardDataRef.current?.organizations ?? [],
      baselineEvaluationRequests: dashboardDataRef.current?.evaluationRequests ?? [],
      baselineResultSummaries: dashboardDataRef.current?.resultSummaries ?? [],
      baselineLatestIssueCounts: dashboardDataRef.current?.latestIssueCounts ?? [],
      baselineScoreResults: dashboardDataRef.current?.scoreResults ?? [],
      incompleteSnapshotCount: 0,
      protectionActive: true
    };
    const recovery = directoryRecoveryRef.current;
    if (recovery) {
      recovery.leases.set(token, lease);
    } else {
      directoryRecoveryRef.current = {
        leases: new Map([[token, lease]]),
        lastConsistentData: dashboardDataRef.current
      };
    }

    if (activeLoadRef.current?.isBackground) {
      activeLoadRef.current.controller.abort();
    }
    return token;
  }, []);

  const endDirectoryRecovery = useCallback((token: DirectoryRecoveryToken) => {
    const recovery = directoryRecoveryRef.current;
    if (!recovery) {
      return;
    }

    recovery.leases.delete(token);
    if (recovery.leases.size === 0) {
      directoryRecoveryRef.current = null;
    }
  }, []);

  const loadDashboard = useCallback<LoadDashboard>(
    async ({
      background = false,
      awaitInFlight = false,
      refreshAfterInFlight = false,
      showLoading = false,
      clearOnError = false,
      signal
    } = {}) => {
      if (signal?.aborted) {
        return null;
      }

      let inheritedLoading = false;
      // A manual or mutation refresh must not queue forever behind a stalled
      // bootstrap/poll. Detach it immediately; the load id below prevents a
      // late continuation from painting stale data or clearing newer state.
      if (refreshAfterInFlight && activeLoadRef.current) {
        const supersededLoad = activeLoadRef.current;
        inheritedLoading = supersededLoad.managesLoading;
        activeLoadRef.current = null;
        supersededLoad.controller.abort();
        supersededLoad.cleanup();
      } else if (showLoading) {
        // Strict Mode remounts the bootstrap effect after aborting its first
        // request. Wait for that owned request to settle before starting the
        // live replacement so development mode does not duplicate GETs.
        while (activeLoadRef.current) {
          const activePromise = activeLoadRef.current.promise;
          const waited = await waitForLoadOrAbort(activePromise, signal);
          if (waited.aborted) {
            return null;
          }
        }
      } else if (activeLoadRef.current) {
        if (!awaitInFlight) {
          return null;
        }

        const waited = await waitForLoadOrAbort(activeLoadRef.current.promise, signal);
        return waited.aborted ? null : waited.value;
      }

      const loadAbortController = new AbortController();
      const loadId = Symbol("dashboard-overview-load");
      const managesLoading = showLoading || inheritedLoading;
      let didTimeout = false;
      let didCancel = false;
      const forwardExternalAbort = () => {
        loadAbortController.abort(signal?.reason);
      };
      signal?.addEventListener("abort", forwardExternalAbort, { once: true });
      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        loadAbortController.abort(DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE);
      }, DASHBOARD_OVERVIEW_TIMEOUT_MS);
      let resourcesReleased = false;
      const cleanupLoadResources = () => {
        if (resourcesReleased) {
          return;
        }
        resourcesReleased = true;
        window.clearTimeout(timeoutId);
        signal?.removeEventListener("abort", forwardExternalAbort);
      };
      const isCurrentLoad = () => activeLoadRef.current?.id === loadId;

      let loadPromise!: Promise<DashboardViewModel | null>;
      loadPromise = (async (): Promise<DashboardViewModel | null> => {
        if (showLoading) {
          setIsDashboardLoading(true);
        }

        try {
          const nextData = await fetchDashboardViewModel(loadAbortController.signal);
          if (!isCurrentLoad()) {
            return nextData;
          }
          const visibleData = protectRecoverySnapshot(
            nextData,
            directoryRecoveryRef.current
          );
          const previousData = dashboardDataRef.current;
          setTrackedRequests((current) => {
            const remaining = Object.fromEntries(Object.entries(current).filter(([, tracked]) => {
              const targetVisible = visibleData.organizations.some((organization) =>
                organization.evaluationTargets.some((target) => target.id === tracked.evaluationTargetId));
              const targetRemoved = !targetVisible && previousData?.organizations.some((organization) =>
                organization.evaluationTargets.some((target) => target.id === tracked.evaluationTargetId));
              if (targetRemoved && !visibleData.evaluationRequests.some((request) => request.id === tracked.id)) return false;
              return !visibleData.evaluationRequests.some((request) =>
                request.id === tracked.id && requestHasNotRolledBack(tracked, request)
              ) || !targetVisible;
            }));
            return Object.keys(remaining).length === Object.keys(current).length ? current : remaining;
          });
          const nextSignature = createDashboardSnapshotSignature(visibleData);
          if (dashboardSnapshotSignatureRef.current !== nextSignature) {
            dashboardSnapshotSignatureRef.current = nextSignature;
            dashboardDataRef.current = visibleData;
            setDashboardData(visibleData);
          }
          setDashboardError("");
          return dashboardDataRef.current ?? visibleData;
        } catch (error) {
          if (didTimeout) {
            if (isCurrentLoad()) {
              setDashboardError(DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE);
              if (clearOnError) {
                dashboardDataRef.current = null;
                dashboardSnapshotSignatureRef.current = null;
                setDashboardData(null);
              }
            }
            return null;
          }

          if (isAbortError(error)) {
            didCancel = true;
            return null;
          }

          if (isCurrentLoad()) {
            setDashboardError(getApiErrorMessage(error, "대시보드 데이터를 가져오지 못했습니다."));
            if (clearOnError) {
              dashboardDataRef.current = null;
              dashboardSnapshotSignatureRef.current = null;
              setDashboardData(null);
            }
          }
          return null;
        } finally {
          cleanupLoadResources();
          if (isCurrentLoad()) {
            activeLoadRef.current = null;

            // A successful/error/timeout replacement refresh can finish a
            // bootstrap it superseded. Caller/unmount aborts remain silent.
            const completesBootstrap = !didCancel && !isBootstrappedRef.current;
            if (completesBootstrap) {
              isBootstrappedRef.current = true;
              onBootstrapComplete?.();
            }

            if (managesLoading || completesBootstrap) {
              setIsDashboardLoading(false);
            }
          }
        }
      })();

      activeLoadRef.current = {
        cleanup: cleanupLoadResources,
        controller: loadAbortController,
        id: loadId,
        isBackground: background || (!refreshAfterInFlight && !showLoading),
        managesLoading,
        promise: loadPromise
      };
      return loadPromise;
    },
    [onBootstrapComplete]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboard({ showLoading: true, clearOnError: true, signal: controller.signal });

    return () => {
      controller.abort();
      const activeLoad = activeLoadRef.current;
      activeLoadRef.current = null;
      activeLoad?.controller.abort();
      activeLoad?.cleanup();
    };
  }, [loadDashboard]);

  const visibleDashboardData = useMemo(() => {
    if (!dashboardData && Object.keys(trackedRequests).length === 0) return null;
    const base = dashboardData ?? { organizations: [], evaluationRequests: [], resultSummaries: [], latestIssueCounts: [], scoreResults: [] };
    const requests = new Map<number, EvaluationRequestModel>(base.evaluationRequests.map((request) => [request.id, request]));
    for (const tracked of Object.values(trackedRequests)) {
      const existing = requests.get(tracked.id);
      if (!existing || requestHasNotRolledBack(existing, tracked)) requests.set(tracked.id, tracked);
    }
    return { ...base, evaluationRequests: [...requests.values()] };
  }, [dashboardData, trackedRequests]);
  // Keep retrying an overview that has not yet acknowledged a terminal response.
  const activeRequestKey = [...new Set([
    ...(dashboardData?.evaluationRequests.filter((request) =>
      request.status !== "COMPLETED" && request.status !== "FAILED").map((request) => request.id) ?? []),
    ...Object.values(trackedRequests).map((request) => request.id)
  ])].sort((a, b) => a - b).join(",");
  const activeEvaluationRequestIds = useMemo(() =>
    activeRequestKey ? activeRequestKey.split(",").map(Number) : [], [activeRequestKey]);

  useEffect(() => {
    if (activeEvaluationRequestIds.length === 0) {
      return;
    }

    const lifecycleController = new AbortController();
    let statusPollInFlight = false;

    const refreshOverview = async () => {
      await loadDashboard({
        background: true,
        refreshAfterInFlight: true,
        signal: lifecycleController.signal
      });
    };

    const pollActiveRequestStatuses = async () => {
      if (
        statusPollInFlight ||
        lifecycleController.signal.aborted ||
        document.visibilityState === "hidden"
      ) {
        return;
      }

      statusPollInFlight = true;
      const statusController = new AbortController();
      let didTimeout = false;
      const forwardLifecycleAbort = () => {
        statusController.abort(lifecycleController.signal.reason);
      };
      lifecycleController.signal.addEventListener("abort", forwardLifecycleAbort, { once: true });
      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        statusController.abort();
      }, DASHBOARD_STATUS_POLL_TIMEOUT_MS);
      let statusResourcesReleased = false;
      const releaseStatusResources = () => {
        if (statusResourcesReleased) {
          return;
        }
        statusResourcesReleased = true;
        window.clearTimeout(timeoutId);
        lifecycleController.signal.removeEventListener("abort", forwardLifecycleAbort);
      };

      try {
        const outcomes = await Promise.allSettled(
          activeEvaluationRequestIds.map((requestId) =>
            fetchEvaluationRequest(requestId, statusController.signal)
          )
        );
        releaseStatusResources();
        if (lifecycleController.signal.aborted) return;
        const requests = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        for (const request of requests) trackEvaluationRequest(request);
        if (
          outcomes.some((outcome) => outcome.status === "rejected") ||
          requests.some(
            (request) => request.status === "COMPLETED" || request.status === "FAILED"
          ) ||
          // An accepted page may not be in the first overview yet. Retry its
          // directory entry while it is queued so the recent tab can appear.
          requests.some((request) =>
            !dashboardDataRef.current?.organizations.some((organization) =>
              organization.evaluationTargets.some((target) => target.id === request.evaluationTargetId))
          )
        ) {
          await refreshOverview();
        }
      } catch (error) {
        statusController.abort();
        releaseStatusResources();
        if (!lifecycleController.signal.aborted && (didTimeout || !isAbortError(error))) {
          // A missing/malformed/stalled status response may mean the request was
          // replaced or removed. Fall back to the authoritative snapshot once;
          // normal successful polls never pay for this full response.
          await refreshOverview();
        }
      } finally {
        releaseStatusResources();
        statusPollInFlight = false;
      }
    };

    const intervalId = window.setInterval(
      () => void pollActiveRequestStatuses(),
      DASHBOARD_STATUS_POLL_INTERVAL_MS
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void pollActiveRequestStatuses();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      lifecycleController.abort();
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEvaluationRequestIds, loadDashboard, trackEvaluationRequest]);

  return {
    dashboardData: visibleDashboardData,
    trackEvaluationRequest,
    dashboardError,
    beginDirectoryRecovery,
    endDirectoryRecovery,
    isDashboardLoading,
    loadDashboard
  };
}
