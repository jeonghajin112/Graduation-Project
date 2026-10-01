import { describe, expect, it, vi } from "vitest";

import type { DashboardViewModel } from "@/types/accessibility-domain";

import { createDashboardLoadCoordinator, type DashboardLoadHandlers } from "./dashboard-load-coordinator";

function snapshot(label: string): DashboardViewModel {
  return {
    organizations: [{ id: 1, name: label, description: "", status: "ACTIVE", updatedAt: "2026-10-01T00:00:00Z", evaluationTargets: [] }],
    evaluationRequests: [],
    resultSummaries: [],
    latestIssueCounts: [],
    scoreResults: []
  };
}

type PendingFetch = {
  signal: AbortSignal;
  resolve: (value: DashboardViewModel) => void;
};

function setup() {
  const fetches: PendingFetch[] = [];
  const handlers: DashboardLoadHandlers = {
    fetchDashboard: vi.fn((signal: AbortSignal) => new Promise<DashboardViewModel>((resolve, reject) => {
      fetches.push({ signal, resolve });
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })),
    applySnapshot: vi.fn((data: DashboardViewModel) => data),
    reportError: vi.fn(),
    setLoading: vi.fn(),
    onBootstrapComplete: vi.fn()
  };
  const coordinator = createDashboardLoadCoordinator(() => handlers);
  return { coordinator, fetches, handlers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("dashboard load coordinator", () => {
  it("hands a superseded foreground caller the replacement's snapshot instead of null", async () => {
    const { coordinator, fetches } = setup();
    const manualRefresh = coordinator.load({ refreshAfterInFlight: true, showLoading: true });
    const mutationRefresh = coordinator.load({ refreshAfterInFlight: true });
    expect(fetches[0]!.signal.aborted).toBe(true);
    const fresh = snapshot("fresh");
    fetches[1]!.resolve(fresh);
    await expect(mutationRefresh).resolves.toBe(fresh);
    await expect(manualRefresh).resolves.toBe(fresh);
  });

  it("queues a status-poll refresh behind a foreground refresh instead of cancelling it", async () => {
    const { coordinator, fetches } = setup();
    const organizationCreateRefresh = coordinator.load({ refreshAfterInFlight: true });
    const pollRefresh = coordinator.load({ background: true, refreshAfterInFlight: true });
    await flush();
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.signal.aborted).toBe(false);

    const created = snapshot("created");
    fetches[0]!.resolve(created);
    await expect(organizationCreateRefresh).resolves.toBe(created);
    await flush();
    // The poll still refreshes afterwards with data newer than its observation.
    expect(fetches).toHaveLength(2);
    const polled = snapshot("polled");
    fetches[1]!.resolve(polled);
    await expect(pollRefresh).resolves.toBe(polled);
  });

  it("lets a foreground refresh replace a background poll", async () => {
    const { coordinator, fetches } = setup();
    const pollRefresh = coordinator.load({ background: true, refreshAfterInFlight: true });
    await flush();
    const manualRefresh = coordinator.load({ refreshAfterInFlight: true, showLoading: true });
    expect(fetches[0]!.signal.aborted).toBe(true);
    const fresh = snapshot("fresh");
    fetches[1]!.resolve(fresh);
    await expect(manualRefresh).resolves.toBe(fresh);
    await expect(pollRefresh).resolves.toBe(fresh);
  });

  it("restarts the bootstrap when its replacement is cancelled by its own caller", async () => {
    const { coordinator, fetches, handlers } = setup();
    const bootstrapController = new AbortController();
    void coordinator.load({ showLoading: true, clearOnError: true, signal: bootstrapController.signal });
    const replacementController = new AbortController();
    const replacement = coordinator.load({ refreshAfterInFlight: true, signal: replacementController.signal });
    replacementController.abort();
    await expect(replacement).resolves.toBeNull();
    await flush();

    expect(handlers.onBootstrapComplete).not.toHaveBeenCalled();
    expect(handlers.setLoading).not.toHaveBeenCalledWith(false);
    expect(fetches).toHaveLength(3);
    fetches[2]!.resolve(snapshot("booted"));
    await flush();
    expect(handlers.onBootstrapComplete).toHaveBeenCalledTimes(1);
    expect(handlers.setLoading).toHaveBeenLastCalledWith(false);
  });

  it("stays silent when the owner detaches the bootstrap on unmount", async () => {
    const { coordinator, fetches, handlers } = setup();
    const controller = new AbortController();
    const bootstrap = coordinator.load({ showLoading: true, clearOnError: true, signal: controller.signal });
    controller.abort();
    coordinator.cancelActiveLoad();
    await expect(bootstrap).resolves.toBeNull();
    await flush();
    expect(fetches).toHaveLength(1);
    expect(handlers.onBootstrapComplete).not.toHaveBeenCalled();
    expect(handlers.reportError).not.toHaveBeenCalled();
  });

  it("does not report a caller cancellation as a dashboard error", async () => {
    const { coordinator, fetches, handlers } = setup();
    const bootstrap = coordinator.load({ showLoading: true, clearOnError: true });
    fetches[0]!.resolve(snapshot("booted"));
    await bootstrap;
    const controller = new AbortController();
    const refresh = coordinator.load({ refreshAfterInFlight: true, signal: controller.signal });
    controller.abort("요청 처리에 시간이 오래 걸리고 있습니다.");
    await expect(refresh).resolves.toBeNull();
    expect(handlers.reportError).not.toHaveBeenCalled();
  });
});
