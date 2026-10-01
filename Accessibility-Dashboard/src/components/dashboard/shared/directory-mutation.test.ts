import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "@/services/backend-api";
import type { EvaluationTarget, Organization } from "@/types/accessibility-domain";

import {
  DIRECTORY_RESULT_UNKNOWN_ERROR,
  DIRECTORY_STATUS_ERROR,
  readEvaluationTargetRemoved,
  readOrganizationRemoved,
  readOrganizationUpdateApplied,
  runDirectoryMutation
} from "./directory-mutation";

function stalled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.spyOn(api, "fetchDashboardViewModel").mockRejectedValue(new Error("the overview must not be read"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("directory mutation recovery", () => {
  it("does not send PATCH when a previous attempt has already been applied", async () => {
    const operation = vi.fn();
    await runDirectoryMutation({ operation, readApplied: async () => true, signal: new AbortController().signal });
    expect(operation).not.toHaveBeenCalled();
  });

  it("aborts a stalled PATCH at 15 seconds and recovers a committed result using GET only", async () => {
    let applied = false;
    const readApplied = vi.fn(async () => applied);
    const operation = vi.fn((signal: AbortSignal) => { applied = true; return stalled(signal); });
    const result = runDirectoryMutation({ operation, readApplied, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation.mock.calls[0][0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(operation.mock.calls[0][0].aborted).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(readApplied).toHaveBeenCalledTimes(2);
    expect(api.fetchDashboardViewModel).not.toHaveBeenCalled();
  });

  it("stops when the initial state lookup stalls without sending a mutation", async () => {
    const operation = vi.fn();
    const result = runDirectoryMutation({ operation, readApplied: stalled, signal: new AbortController().signal });
    const assertion = expect(result).rejects.toThrow(DIRECTORY_STATUS_ERROR);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(operation).not.toHaveBeenCalled();
  });

  it("bounds recovery GET as well as PATCH and does not automatically repeat the mutation", async () => {
    const readApplied = vi.fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementation(stalled);
    const operation = vi.fn(stalled);
    const result = runDirectoryMutation({ operation, readApplied, signal: new AbortController().signal });
    const assertion = expect(result).rejects.toThrow(DIRECTORY_RESULT_UNKNOWN_ERROR);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(operation).toHaveBeenCalledTimes(1);
    expect(readApplied).toHaveBeenCalledTimes(2);
  });

  it("preserves definitive rejection without treating it as an uncertain commit", async () => {
    const error = new api.ApiRequestError({ method: "PATCH", path: "/targets/1/delete", payload: null,
      status: 403, url: "http://localhost/api/targets/1/delete", message: "Forbidden" });
    const readApplied = vi.fn(async () => false);
    await expect(runDirectoryMutation({ operation: async () => { throw error; }, readApplied,
      signal: new AbortController().signal })).rejects.toBe(error);
    expect(readApplied).toHaveBeenCalledTimes(1);
  });

  it("cancels work on unmount without starting a reconciliation lookup", async () => {
    const controller = new AbortController();
    const operation = vi.fn(stalled);
    const readApplied = vi.fn(async () => false);
    const result = runDirectoryMutation({ operation, readApplied, signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(operation.mock.calls[0][0].aborted).toBe(true);
    expect(readApplied).toHaveBeenCalledTimes(1);
  });
});

describe("single-entity applied checks", () => {
  const organization = (overrides: Partial<Organization> = {}): Organization => ({
    id: 1, name: "Project", description: "", status: "ACTIVE", updatedAt: "2026-10-01T00:00:00Z", ...overrides
  });
  const target = (status: EvaluationTarget["status"]): EvaluationTarget => ({
    id: 101, organizationId: 1, name: "Page", targetType: "WEB", accessUrl: "https://example.com/",
    status, createdAt: "2026-10-01T00:00:00Z"
  });
  const signal = new AbortController().signal;

  it("reads only the edited project instead of the whole dashboard", async () => {
    const read = vi.spyOn(api, "fetchOrganizationState").mockResolvedValue(organization({ name: "Renamed" }));
    await expect(readOrganizationUpdateApplied({ projectId: 1, name: "Renamed", description: "" })(signal)).resolves.toBe(true);
    await expect(readOrganizationUpdateApplied({ projectId: 1, name: "Other", description: "" })(signal)).resolves.toBe(false);
    expect(read).toHaveBeenCalledWith(1, signal);
    expect(api.fetchDashboardViewModel).not.toHaveBeenCalled();
  });

  it("treats a deactivated or missing project as removed", async () => {
    vi.spyOn(api, "fetchOrganizationState")
      .mockResolvedValueOnce(organization({ status: "INACTIVE" }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(organization());
    await expect(readOrganizationRemoved(1)(signal)).resolves.toBe(true);
    await expect(readOrganizationRemoved(1)(signal)).resolves.toBe(true);
    await expect(readOrganizationRemoved(1)(signal)).resolves.toBe(false);
  });

  it("treats a logically deleted or missing page as removed", async () => {
    vi.spyOn(api, "fetchEvaluationTargetState")
      .mockResolvedValueOnce(target("DELETED"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(target("ACTIVE"));
    await expect(readEvaluationTargetRemoved(101)(signal)).resolves.toBe(true);
    await expect(readEvaluationTargetRemoved(101)(signal)).resolves.toBe(true);
    await expect(readEvaluationTargetRemoved(101)(signal)).resolves.toBe(false);
  });
});
