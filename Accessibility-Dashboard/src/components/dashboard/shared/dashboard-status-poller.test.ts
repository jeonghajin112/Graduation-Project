import { afterEach, expect, it, vi } from "vitest";
import { fetchEvaluationStatuses } from "@/services/analysis-protocol-api";
import type { EvaluationRequestModel } from "@/types/accessibility-domain";
import { createDashboardStatusPoller } from "./dashboard-status-poller";

vi.mock("@/services/backend-api", () => ({
  isAbortError: (error: Error) => error.name === "AbortError"
}));
vi.mock("@/services/analysis-protocol-api", () => ({ fetchEvaluationStatuses: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type StatusEntries = Awaited<ReturnType<typeof fetchEvaluationStatuses>>;

it("applies fast batches immediately, bounds concurrent transports, and ignores late aborted results", async () => {
  vi.stubGlobal("document", { visibilityState: "visible" });
  const pending: Array<{ ids: readonly number[]; resolve: (entries: StatusEntries) => void }> = [];
  vi.mocked(fetchEvaluationStatuses).mockImplementation(ids =>
    new Promise(resolve => pending.push({ ids, resolve })));
  const request = (id: number): EvaluationRequestModel => ({
    id, evaluationTargetId: 101, status: "COMPLETED", requestedAt: "", updatedAt: ""
  });
  const found = (ids: readonly number[]): StatusEntries =>
    ids.map(id => ({ id, outcome: "FOUND" as const, request: request(id) }));
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const controller = new AbortController();
  const track = vi.fn();
  const refresh = vi.fn(() => new Promise<null>(() => {}));
  const poll = createDashboardStatusPoller({
    activeEvaluationRequestIds: Array.from({ length: 500 }, (_, index) => index + 1),
    observations: new Map(),
    getDashboard: () => null, signal: controller.signal, timeoutMs: 10000,
    loadDashboard: refresh, trackEvaluationRequest: track,
    forgetRequest: vi.fn(), updatePausedCount: vi.fn()
  });
  poll();
  expect(pending.map(batch => batch.ids[0])).toEqual([1, 101, 201, 301]);
  expect(pending.every(batch => batch.ids.length === 100)).toBe(true);
  pending[1]!.resolve(found(pending[1]!.ids));
  await flush();
  expect(track.mock.calls.map(([value]) => value.id)).toEqual(pending[1]!.ids);
  expect(refresh).toHaveBeenCalledTimes(1);
  poll();
  expect(pending.map(batch => batch.ids[0])).toEqual([1, 101, 201, 301, 401]);
  controller.abort();
  for (const batch of [pending[0]!, pending[2]!, pending[3]!, pending[4]!]) batch.resolve(found(batch.ids));
  await flush();
  expect(track).toHaveBeenCalledTimes(100);
});
