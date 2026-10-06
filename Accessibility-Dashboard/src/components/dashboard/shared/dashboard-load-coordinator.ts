import { createRequestDeadline } from "@/services/async-cancellation";
import { getApiErrorMessage, isAbortError } from "@/services/backend-api";
import type { DashboardViewModel } from "@/types/accessibility-domain";

export type LoadDashboardOptions = {
  background?: boolean;
  awaitInFlight?: boolean;
  refreshAfterInFlight?: boolean;
  showLoading?: boolean;
  clearOnError?: boolean;
  signal?: AbortSignal;
};

export type LoadDashboard = (options?: LoadDashboardOptions) => Promise<DashboardViewModel | null>;

export const DASHBOARD_OVERVIEW_TIMEOUT_MS = 15_000;
export const DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE =
  "대시보드를 불러오는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.";
export const DASHBOARD_LOAD_ERROR_MESSAGE = "대시보드 데이터를 가져오지 못했습니다.";

export type DashboardLoadHandlers = {
  fetchDashboard: (signal: AbortSignal) => Promise<DashboardViewModel>;
  /** Applies a snapshot from the current load and returns the data now visible. */
  applySnapshot: (data: DashboardViewModel) => DashboardViewModel;
  reportError: (message: string, clearData: boolean) => void;
  setLoading: (isLoading: boolean) => void;
  onBootstrapComplete: () => void;
};

type ActiveDashboardLoad = {
  cleanup: () => void;
  controller: AbortController;
  id: symbol;
  isBackground: boolean;
  managesLoading: boolean;
  promise: Promise<DashboardViewModel | null>;
  supersede: (successor: Promise<DashboardViewModel | null>) => void;
};

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

/**
 * Owns the single in-flight overview request. It is independent of React so
 * the ordering rules below are unit-testable:
 * - a foreground refresh (manual, mutation, bootstrap) supersedes an older
 *   load, and the superseded caller receives the replacement's result
 *   instead of an empty `null`;
 * - a background refresh (status poller) never cancels a foreground load; it
 *   waits for it and then refreshes with data newer than its observation;
 * - a replacement that is cancelled before the app finished booting starts a
 *   fresh bootstrap so the shell is never left inert.
 */
export function createDashboardLoadCoordinator(getHandlers: () => DashboardLoadHandlers) {
  let activeLoad: ActiveDashboardLoad | null = null;
  let isBootstrapped = false;

  const load: LoadDashboard = async ({
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

    if (background && refreshAfterInFlight) {
      // The status poller observed a change newer than any running load, but
      // cancelling a user's refresh or a mutation's reconciliation would make
      // that caller report a false failure. Queue behind it instead.
      while (activeLoad && !activeLoad.isBackground) {
        const waited = await waitForLoadOrAbort(activeLoad.promise, signal);
        if (waited.aborted) {
          return null;
        }
      }
    }

    let inheritedLoading = false;
    let supersededLoad: ActiveDashboardLoad | null = null;
    // A manual or mutation refresh must not queue forever behind a stalled
    // bootstrap/poll. Detach it immediately; the load id below prevents a
    // late continuation from painting stale data or clearing newer state.
    if (refreshAfterInFlight && activeLoad) {
      supersededLoad = activeLoad;
      inheritedLoading = supersededLoad.managesLoading;
      activeLoad = null;
    } else if (showLoading) {
      // Strict Mode remounts the bootstrap effect after aborting its first
      // request. Wait for that owned request to settle before starting the
      // live replacement so development mode does not duplicate GETs.
      while (activeLoad) {
        const waited = await waitForLoadOrAbort(activeLoad.promise, signal);
        if (waited.aborted) {
          return null;
        }
      }
    } else if (activeLoad) {
      if (!awaitInFlight) {
        return null;
      }

      const waited = await waitForLoadOrAbort(activeLoad.promise, signal);
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
    let successor: Promise<DashboardViewModel | null> | null = null;
    let didCancel = false;
    const cleanupLoadResources = loadDeadline.dispose;
    const isCurrentLoad = () => activeLoad?.id === loadId;

    const loadPromise = (async (): Promise<DashboardViewModel | null> => {
      const handlers = getHandlers();
      if (showLoading) {
        handlers.setLoading(true);
      }

      try {
        const nextData = await handlers.fetchDashboard(loadAbortController.signal);
        if (!isCurrentLoad()) {
          return nextData;
        }
        return getHandlers().applySnapshot(nextData);
      } catch (error) {
        if (loadDeadline.didTimeout()) {
          if (isCurrentLoad()) {
            getHandlers().reportError(DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE, clearOnError);
          }
          return null;
        }

        if (isAbortError(error) || loadAbortController.signal.aborted) {
          if (successor !== null && !signal?.aborted) {
            // Replaced, not cancelled: hand the caller the newer snapshot.
            return successor;
          }
          didCancel = true;
          return null;
        }

        if (isCurrentLoad()) {
          getHandlers().reportError(getApiErrorMessage(error, DASHBOARD_LOAD_ERROR_MESSAGE), clearOnError);
        }
        return null;
      } finally {
        cleanupLoadResources();
        if (isCurrentLoad()) {
          activeLoad = null;

          // A successful/error/timeout replacement refresh can finish a
          // bootstrap it superseded. Unmount aborts remain silent because
          // cancelActiveLoad detaches the active load before aborting it.
          const completesBootstrap = !didCancel && !isBootstrapped;
          if (completesBootstrap) {
            isBootstrapped = true;
            getHandlers().onBootstrapComplete();
          }

          if (didCancel && !isBootstrapped) {
            // The replacement's own caller gave up (modal closed, deadline)
            // while the app was still booting. Keep the loading state and
            // start a fresh bootstrap instead of leaving the shell inert.
            queueMicrotask(() => {
              if (!isBootstrapped && activeLoad === null) {
                void load({ showLoading: true, clearOnError: true });
              }
            });
          } else if (managesLoading || completesBootstrap) {
            getHandlers().setLoading(false);
          }
        }
      }
    })();

    activeLoad = {
      cleanup: cleanupLoadResources,
      controller: loadAbortController,
      id: loadId,
      isBackground: background || (!refreshAfterInFlight && !showLoading),
      managesLoading,
      promise: loadPromise,
      supersede: (next) => {
        successor = next;
      }
    };
    if (supersededLoad) {
      supersededLoad.supersede(loadPromise);
      supersededLoad.controller.abort();
      supersededLoad.cleanup();
    }
    return loadPromise;
  };

  return {
    load,
    /** Aborts only a background load, e.g. before a directory mutation. */
    abortBackgroundLoad: () => {
      if (activeLoad?.isBackground) {
        activeLoad.controller.abort();
      }
    },
    /** Detaches and aborts the active load (bootstrap effect cleanup/unmount). */
    cancelActiveLoad: () => {
      const current = activeLoad;
      activeLoad = null;
      current?.controller.abort();
      current?.cleanup();
    }
  };
}
