import { afterEach, expect, it, vi } from "vitest";
import { fetchEvaluationRequest } from "@/services/backend-api";
import type { EvaluationRequestModel } from "@/types/accessibility-domain";
import { createDashboardStatusPoller } from "./dashboard-status-poller";

vi.mock("@/services/backend-api", () => ({
  fetchEvaluationRequest: vi.fn(),
  isAbortError: (error: Error) => error.name === "AbortError"
}));
vi.mock("@/services/analysis-protocol-api", () => ({ fetchEvaluationStatuses: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("applies fast peers immediately, bounds concurrent transports, and ignores late aborted results", async () => {
  vi.stubGlobal("document", { visibilityState: "visible" });
  const pending = new Map<number, (value: EvaluationRequestModel) => void>();
  vi.mocked(fetchEvaluationRequest).mockImplementation(id => new Promise(resolve => pending.set(id, resolve)));
  const request = (id: number): EvaluationRequestModel => ({
    id, evaluationTargetId: 101, status: "COMPLETED", requestedAt: "", updatedAt: ""
  });
  const controller = new AbortController();
  const track = vi.fn();
  const refresh = vi.fn(() => new Promise<null>(() => {}));
  const poll = createDashboardStatusPoller({
    activeEvaluationRequestIds: [1, 2, 3, 4, 5], observations: new Map(),
    getDashboard: () => null, signal: controller.signal, timeoutMs: 10000,
    loadDashboard: refresh, trackEvaluationRequest: track,
    forgetRequest: vi.fn(), updatePausedCount: vi.fn()
  });
  poll();
  expect([...pending.keys()]).toEqual([1, 2, 3, 4]);
  pending.get(2)!(request(2));
  pending.get(3)!(request(3));
  await Promise.resolve();
  expect(track.mock.calls.map(([value]) => value.id)).toEqual([2, 3]);
  expect(refresh).toHaveBeenCalledTimes(1);
  poll();
  expect(pending.has(5)).toBe(true);
  controller.abort();
  pending.get(1)!(request(1));
  pending.get(4)!(request(4));
  pending.get(5)!(request(5));
  await Promise.resolve();
  expect(track.mock.calls.map(([value]) => value.id)).toEqual([2, 3]);
});
