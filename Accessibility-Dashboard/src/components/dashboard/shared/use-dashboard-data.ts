import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createRequestDeadline } from "@/services/async-cancellation";
import {
  fetchDashboardViewModel,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";
import type { DashboardViewModel, EvaluationRequestModel } from "@/types/accessibility-domain";
import { type RequestPollObservation } from "./request-poll-policy";

import {
  createDirectoryRecoveryLease,
  protectRecoverySnapshot,
  requestHasNotRolledBack,
  type DirectoryRecovery,
  type DirectoryRecoveryToken
} from "./dashboard-recovery";

export type { DirectoryRecoveryToken } from "./dashboard-recovery";

type LoadDashboardOptions = {
  background?: boolean;
  awaitInFlight?: boolean;
  refreshAfterInFlight?: boolean;
  showLoading?: boolean;
  clearOnError?: boolean;
  signal?: AbortSignal;
};

export type LoadDashboard = (options?: LoadDashboardOptions) => Promise<DashboardViewModel | null>;

type ActiveDashboardLoad = {
  cleanup: () => void;
  controller: AbortController;
  id: symbol;
  isBackground: boolean;
  managesLoading: boolean;
  promise: Promise<DashboardViewModel | null>;
};

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
  const pollObservations = useRef(new Map<number, RequestPollObservation>());
  const [pausedStatusCount, setPausedStatusCount] = useState(0);
  const [statusRetryRevision, setStatusRetryRevision] = useState(0);
  const retryStatusChecks = useCallback(() => {
    pollObservations.current.clear();
    setPausedStatusCount(0);
    setStatusRetryRevision(revision => revision + 1);
  }, []);
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
    const lease = createDirectoryRecoveryLease(dashboardDataRef.current);
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

      const loadDeadline = createRequestDeadline({
        signal,
        timeoutMs: DASHBOARD_OVERVIEW_TIMEOUT_MS,
        timeoutReason: DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE
      });
      const loadAbortController = loadDeadline.controller;
      const loadId = Symbol("dashboard-overview-load");
      const managesLoading = showLoading || inheritedLoading;
      let didCancel = false;
      const cleanupLoadResources = loadDeadline.dispose;
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
          if (loadDeadline.didTimeout()) {
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
    const activeIds = new Set(activeEvaluationRequestIds);
    for (const id of pollObservations.current.keys()) if (!activeIds.has(id)) pollObservations.current.delete(id);
    const updatePausedCount = () => setPausedStatusCount([...pollObservations.current.values()].filter(value => value.paused && !value.removed).length);
    updatePausedCount();
    if (activeEvaluationRequestIds.length === 0) {
      return;
    }

    const lifecycleController = new AbortController();
    let poller: Promise<() => void> | null = null;
    const pollActiveRequestStatuses = () => {
      if (lifecycleController.signal.aborted || document.visibilityState === "hidden") return;
      poller ??= import("./dashboard-status-poller").then(({ createDashboardStatusPoller }) =>
        createDashboardStatusPoller({
          activeEvaluationRequestIds,
          observations: pollObservations.current,
          getDashboard: () => dashboardDataRef.current,
          signal: lifecycleController.signal,
          timeoutMs: DASHBOARD_STATUS_POLL_TIMEOUT_MS,
          loadDashboard,
          trackEvaluationRequest,
          forgetRequest: id => setTrackedRequests(current => {
            const next = { ...current };
            delete next[id];
            return next;
          }),
          updatePausedCount
        }));
      void poller.then(poll => poll()).catch(() => {
        poller = null;
        if (!lifecycleController.signal.aborted) {
          setDashboardError("상태 확인 기능을 불러오지 못했습니다. 다음 조회 때 다시 시도합니다.");
        }
      });
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
    if (statusRetryRevision > 0) pollActiveRequestStatuses();

    return () => {
      lifecycleController.abort();
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEvaluationRequestIds, loadDashboard, trackEvaluationRequest, statusRetryRevision]);

  return {
    dashboardData: visibleDashboardData,
    trackEvaluationRequest,
    dashboardError,
    pausedStatusCount,
    retryStatusChecks,
    beginDirectoryRecovery,
    endDirectoryRecovery,
    isDashboardLoading,
    loadDashboard
  };
}
