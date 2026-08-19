import { useCallback, useEffect, useRef, useState } from "react";

import { fetchDashboardViewModel, getApiErrorMessage, isAbortError } from "@/services/backend-api";
import type { DashboardViewModel } from "@/types/accessibility-domain";

type LoadDashboardOptions = {
  awaitInFlight?: boolean;
  refreshAfterInFlight?: boolean;
  showLoading?: boolean;
  clearOnError?: boolean;
  forceDirectoryRefresh?: boolean;
  signal?: AbortSignal;
};

export type LoadDashboard = (options?: LoadDashboardOptions) => Promise<DashboardViewModel | null>;
export type DirectoryRecoveryToken = symbol;

type DirectoryRecoveryLease = {
  token: DirectoryRecoveryToken;
  baselineOrganizations: DashboardViewModel["organizations"];
  baselineEvaluationRequests: DashboardViewModel["evaluationRequests"];
  baselineResultSummaries: DashboardViewModel["resultSummaries"];
  baselineEvaluationIssues: DashboardViewModel["evaluationIssues"];
  baselineScoreResults: DashboardViewModel["scoreResults"];
  autoForceLoadsRemaining: number;
  incompleteSnapshotCount: number;
  protectionActive: boolean;
};

type DirectoryRecovery = {
  leases: Map<DirectoryRecoveryToken, DirectoryRecoveryLease>;
  lastConsistentData: DashboardViewModel | null;
};

const MAX_INCOMPLETE_RECOVERY_SNAPSHOTS = 4;
const MAX_AUTO_FORCE_RECOVERY_LOADS = 4;

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

function shouldForceRecoveryDirectory(recovery: DirectoryRecovery | null): boolean {
  if (!recovery) {
    return false;
  }

  let shouldForce = false;
  for (const lease of recovery.leases.values()) {
    if (!lease.protectionActive || lease.autoForceLoadsRemaining <= 0) {
      continue;
    }

    // One fresh directory request advances every lease that was active when
    // it started, while a lease created later receives its own full budget.
    lease.autoForceLoadsRemaining -= 1;
    shouldForce = true;
  }

  // Cache bypass and snapshot protection have separate lifetimes. Exhausting
  // one lease's automatic force budget must not disable another lease or make
  // a transiently incomplete response erase otherwise consistent results.
  return shouldForce;
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
  const nextEvaluationIssueIds = new Set(
    nextData.evaluationIssues.map((issue) => issue.id)
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
      lease.baselineEvaluationIssues.every((issue) =>
        nextEvaluationIssueIds.has(issue.id)
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
  const activeLoadPromiseRef = useRef<Promise<DashboardViewModel | null> | null>(null);
  const activeLoadAbortControllerRef = useRef<AbortController | null>(null);
  const activeLoadIsBackgroundRef = useRef(false);
  const directoryRecoveryRef = useRef<DirectoryRecovery | null>(null);

  const beginDirectoryRecovery = useCallback((): DirectoryRecoveryToken => {
    const token = Symbol("directory-recovery");
    const lease: DirectoryRecoveryLease = {
      token,
      autoForceLoadsRemaining: MAX_AUTO_FORCE_RECOVERY_LOADS,
      baselineOrganizations: dashboardDataRef.current?.organizations ?? [],
      baselineEvaluationRequests: dashboardDataRef.current?.evaluationRequests ?? [],
      baselineResultSummaries: dashboardDataRef.current?.resultSummaries ?? [],
      baselineEvaluationIssues: dashboardDataRef.current?.evaluationIssues ?? [],
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

    if (activeLoadIsBackgroundRef.current) {
      activeLoadAbortControllerRef.current?.abort();
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
      awaitInFlight = false,
      refreshAfterInFlight = false,
      showLoading = false,
      clearOnError = false,
      forceDirectoryRefresh = false,
      signal
    } = {}) => {
      // A Strict Mode remount starts a new bootstrap load while the first
      // effect's request is still aborting. Bootstrap and mutation refreshes
      // must wait for that promise and then issue a request with their own
      // live signal instead of inheriting the cancelled work.
      if (refreshAfterInFlight || showLoading) {
        while (activeLoadPromiseRef.current) {
          // A background poll has no user-visible owner and may be stalled by
          // the network. A mutation refresh takes priority and replaces it.
          if (refreshAfterInFlight && activeLoadIsBackgroundRef.current) {
            activeLoadAbortControllerRef.current?.abort();
          }
          const activePromise = activeLoadPromiseRef.current;
          const waited = await waitForLoadOrAbort(activePromise, signal);
          if (waited.aborted) {
            return null;
          }
        }
      } else if (activeLoadPromiseRef.current) {
        if (!awaitInFlight) {
          return null;
        }

        const waited = await waitForLoadOrAbort(activeLoadPromiseRef.current, signal);
        return waited.aborted ? null : waited.value;
      }

      const loadAbortController = new AbortController();
      const forwardExternalAbort = () => {
        loadAbortController.abort();
      };
      if (signal?.aborted) {
        loadAbortController.abort();
      } else {
        signal?.addEventListener("abort", forwardExternalAbort, { once: true });
      }

      let loadPromise!: Promise<DashboardViewModel | null>;
      loadPromise = (async (): Promise<DashboardViewModel | null> => {
        let didAbort = false;

        if (showLoading) {
          setIsDashboardLoading(true);
        }

        try {
          const nextData = await fetchDashboardViewModel(
            loadAbortController.signal,
            forceDirectoryRefresh || shouldForceRecoveryDirectory(directoryRecoveryRef.current)
          );
          const visibleData = protectRecoverySnapshot(
            nextData,
            directoryRecoveryRef.current
          );
          dashboardDataRef.current = visibleData;
          setDashboardData(visibleData);
          setDashboardError("");
          return visibleData;
        } catch (error) {
          if (isAbortError(error)) {
            didAbort = true;
            return null;
          }

          setDashboardError(getApiErrorMessage(error, "대시보드 데이터를 가져오지 못했습니다."));
          if (clearOnError) {
            dashboardDataRef.current = null;
            setDashboardData(null);
          }
          return null;
        } finally {
          signal?.removeEventListener("abort", forwardExternalAbort);
          if (activeLoadPromiseRef.current === loadPromise) {
            activeLoadPromiseRef.current = null;
            activeLoadAbortControllerRef.current = null;
            activeLoadIsBackgroundRef.current = false;
          }

          // Strict Mode remount aborts the first showLoading fetch. Polling
          // (showLoading=false) must still be able to clear the boot overlay.
          if (!didAbort && !isBootstrappedRef.current) {
            isBootstrappedRef.current = true;
            onBootstrapComplete?.();
          }

          if (showLoading) {
            setIsDashboardLoading(false);
          }
        }
      })();

      activeLoadPromiseRef.current = loadPromise;
      activeLoadAbortControllerRef.current = loadAbortController;
      activeLoadIsBackgroundRef.current = !refreshAfterInFlight && !showLoading;
      return loadPromise;
    },
    [onBootstrapComplete]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboard({ showLoading: true, clearOnError: true, signal: controller.signal });

    const intervalId = window.setInterval(() => {
      void loadDashboard();
    }, 5000);

    return () => {
      controller.abort();
      activeLoadAbortControllerRef.current?.abort();
      window.clearInterval(intervalId);
    };
  }, [loadDashboard]);

  return {
    dashboardData,
    dashboardError,
    beginDirectoryRecovery,
    endDirectoryRecovery,
    isDashboardLoading,
    loadDashboard,
    setDashboardError
  };
}
