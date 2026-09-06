import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "@/services/backend-api";
import type { DashboardViewModel } from "@/types/accessibility-domain";

import { DIRECTORY_RESULT_UNKNOWN_ERROR, DIRECTORY_STATUS_ERROR, runDirectoryMutation } from "./directory-mutation";

const snapshot: DashboardViewModel = {
  organizations: [], evaluationRequests: [], resultSummaries: [], latestIssueCounts: [], scoreResults: []
};
function stalled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.spyOn(api, "fetchDashboardViewModel").mockResolvedValue(snapshot);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("directory mutation recovery", () => {
  it("does not send PATCH when a previous attempt has already been applied", async () => {
    const operation = vi.fn();
    await runDirectoryMutation({ operation, isApplied: () => true, signal: new AbortController().signal });
    expect(operation).not.toHaveBeenCalled();
  });

  it("aborts a stalled PATCH at 15 seconds and recovers a committed result using GET only", async () => {
    let applied = false;
    const operation = vi.fn((signal: AbortSignal) => { applied = true; return stalled(signal); });
    const result = runDirectoryMutation({ operation, isApplied: () => applied, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation.mock.calls[0][0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(operation.mock.calls[0][0].aborted).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(api.fetchDashboardViewModel).toHaveBeenCalledTimes(2);
  });

  it("stops when the initial state lookup stalls without sending a mutation", async () => {
    vi.mocked(api.fetchDashboardViewModel).mockImplementation(signal => stalled(signal!));
    const operation = vi.fn();
    const result = runDirectoryMutation({ operation, isApplied: () => false, signal: new AbortController().signal });
    const assertion = expect(result).rejects.toThrow(DIRECTORY_STATUS_ERROR);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(operation).not.toHaveBeenCalled();
  });

  it("bounds recovery GET as well as PATCH and does not automatically repeat the mutation", async () => {
    vi.mocked(api.fetchDashboardViewModel).mockResolvedValueOnce(snapshot).mockImplementation(signal => stalled(signal!));
    const operation = vi.fn(stalled);
    const result = runDirectoryMutation({ operation, isApplied: () => false, signal: new AbortController().signal });
    const assertion = expect(result).rejects.toThrow(DIRECTORY_RESULT_UNKNOWN_ERROR);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(operation).toHaveBeenCalledTimes(1);
    expect(api.fetchDashboardViewModel).toHaveBeenCalledTimes(2);
  });

  it("preserves definitive rejection without treating it as an uncertain commit", async () => {
    const error = new api.ApiRequestError({ method: "PATCH", path: "/targets/1/delete", payload: null,
      status: 403, url: "http://localhost/api/targets/1/delete", message: "Forbidden" });
    await expect(runDirectoryMutation({ operation: async () => { throw error; }, isApplied: () => false,
      signal: new AbortController().signal })).rejects.toBe(error);
    expect(api.fetchDashboardViewModel).toHaveBeenCalledTimes(1);
  });

  it("cancels work on unmount without starting a reconciliation lookup", async () => {
    const controller = new AbortController();
    const operation = vi.fn(stalled);
    const result = runDirectoryMutation({ operation, isApplied: () => false, signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(operation.mock.calls[0][0].aborted).toBe(true);
    expect(api.fetchDashboardViewModel).toHaveBeenCalledTimes(1);
  });
});
