import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchDashboardViewModel } from "@/services/backend-api";
import type { DashboardViewModel, EvaluationRequestModel } from "@/types/accessibility-domain";
import { type RequestPollObservation } from "./request-poll-policy";

import {
  createDirectoryRecoveryLease,
  forgetRemovedDirectoryEntry,
  protectRecoverySnapshot,
  requestHasNotRolledBack,
  type DirectoryRecovery,
  type DirectoryRecoveryToken,
  type DirectoryRemoval
} from "./dashboard-recovery";
import {
  createDashboardLoadCoordinator,
  type DashboardLoadHandlers
} from "./dashboard-load-coordinator";

export type { DirectoryRecoveryToken, DirectoryRemoval } from "./dashboard-recovery";
export type { LoadDashboard, LoadDashboardOptions } from "./dashboard-load-coordinator";
export {
  DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE,
  DASHBOARD_OVERVIEW_TIMEOUT_MS
} from "./dashboard-load-coordinator";

export const DASHBOARD_STATUS_POLL_INTERVAL_MS = 5_000;
export const DASHBOARD_STATUS_POLL_TIMEOUT_MS = 10_000;

function createDashboardSnapshotSignature(data: DashboardViewModel): string {
  // The aggregate response is already the UI's complete source of truth. A
  // stable serialized signature lets a successful poll clear a transient
  // error without replacing React state when none of that truth changed.
  return JSON.stringify(data);
}

export function useDashboardData({
  onBootstrapComplete
}: {
  onBootstrapComplete?: () => void;
}) {
  const [dashboardData, setDashboardData] = useState<DashboardViewModel | null>(null);
  const [isDashboardLoading, setIsDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState("");
  const dashboardDataRef = useRef<DashboardViewModel | null>(null);
  const dashboardSnapshotSignatureRef = useRef<string | null>(null);
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

    coordinatorRef.current?.abortBackgroundLoad();
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

  const acknowledgeDirectoryRemoval = useCallback((removal: DirectoryRemoval) => {
    forgetRemovedDirectoryEntry(directoryRecoveryRef.current, removal);
  }, []);

  // Handlers are read at call time, so the coordinator (and loadDashboard)
  // stay stable while each load still uses the latest callbacks.
  const loadHandlersRef = useRef<DashboardLoadHandlers | null>(null);
  loadHandlersRef.current = {
    fetchDashboard: fetchDashboardViewModel,
    applySnapshot: (nextData) => {
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
    },
    reportError: (message, clearData) => {
      setDashboardError(message);
      if (clearData) {
        dashboardDataRef.current = null;
        dashboardSnapshotSignatureRef.current = null;
        setDashboardData(null);
      }
    },
    setLoading: setIsDashboardLoading,
    onBootstrapComplete: () => onBootstrapComplete?.()
  };
  const coordinatorRef = useRef<ReturnType<typeof createDashboardLoadCoordinator> | null>(null);
  coordinatorRef.current ??= createDashboardLoadCoordinator(() => loadHandlersRef.current!);
  const coordinator = coordinatorRef.current;
  const loadDashboard = coordinator.load;

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboard({ showLoading: true, clearOnError: true, signal: controller.signal });

    return () => {
      controller.abort();
      coordinator.cancelActiveLoad();
    };
  }, [coordinator, loadDashboard]);

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
    acknowledgeDirectoryRemoval,
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
