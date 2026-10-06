import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_BASE_URL } from "@/config/api";
import * as protocolApi from "@/services/analysis-protocol-api";
import * as backendApi from "@/services/backend-api";
import { getTargetRescanStorageKey } from "@/services/analysis-recovery-storage";
import {
  SITE_CREATE_RECOVERY_STORAGE_KEY,
  readSiteCreateRecovery,
  readTargetRescanRecovery,
  retireAcceptedTargetAnalysis,
  writeSiteCreateRecovery,
  type PersistedSiteCreateAttempt
} from "@/services/site-create-recovery-storage";
import type { DashboardViewModel, EvaluationRequestModel, EvaluationTarget } from "@/types/accessibility-domain";

import { requestTargetAnalysis, type TargetAnalysisRequestCheckpoint } from "./target-analysis-request";

const timestamp = "2026-10-01T00:00:00Z";

function installSessionStorage() {
  const values = new Map<string, string>();
  const sessionStorage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
  vi.stubGlobal("window", {
    sessionStorage,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  });
  return values;
}

const target = (id: number): EvaluationTarget => ({
  id, organizationId: 1, name: `Page ${id}`, targetType: "WEB",
  accessUrl: `https://example.com/${id}`, status: "ACTIVE", createdAt: timestamp
});

const dashboard: DashboardViewModel = {
  analysisProtocolVersion: 1,
  organizations: [{
    id: 1, name: "Project", description: "", status: "ACTIVE", updatedAt: timestamp,
    evaluationTargets: [101, 102].map((id) => ({
      id, name: `Page ${id}`, targetType: "WEB", accessUrl: `https://example.com/${id}`,
      faviconUrl: null, status: "ACTIVE", createdAt: timestamp
    }))
  }],
  evaluationRequests: [], resultSummaries: [], latestIssueCounts: [], scoreResults: []
};

const request = (id: number, evaluationTargetId: number, status: EvaluationRequestModel["status"] = "PENDING"): EvaluationRequestModel => ({
  id, evaluationTargetId, status, requestedAt: timestamp, updatedAt: timestamp
});

function stalled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

function createContext(loadDashboard = vi.fn(async () => null)) {
  const checkpointRef: { current: TargetAnalysisRequestCheckpoint | null } = { current: null };
  return {
    loadDashboard,
    context: {
      beginDirectoryRecovery: () => Symbol("lease"),
      endDirectoryRecovery: () => {},
      dashboardData: dashboard,
      loadDashboard,
      targetAnalysisRequestCheckpointRef: checkpointRef,
      releaseRequestCheckpoint: (checkpoint: TargetAnalysisRequestCheckpoint | null) => {
        if (checkpointRef.current === checkpoint) checkpointRef.current = null;
      },
      bindCheckpointToSignal: () => {}
    }
  };
}

function seedRescan(targetId: number, overrides: Partial<PersistedSiteCreateAttempt> = {}) {
  window.sessionStorage.setItem(getTargetRescanStorageKey(targetId), JSON.stringify({
    version: 1, attemptId: `seed-${targetId}`, apiScope: API_BASE_URL, projectId: 1,
    name: `Page ${targetId}`, accessUrl: `https://example.com/${targetId}`, previousTargetIds: [101, 102],
    startedAt: Date.now(), phase: "request-reconciling", targetId, knownRequestIds: [],
    previousFailedRequestId: null, analysisKey: "3f5b9a52-1c1e-4a55-9a52-6f3b8b8a1c01", ...overrides
  }));
}

beforeEach(() => {
  installSessionStorage();
  vi.spyOn(backendApi, "fetchEvaluationTarget").mockImplementation(async (id) => target(id));
  vi.spyOn(protocolApi, "fetchActiveTargetRequests").mockResolvedValue([]);
  vi.spyOn(protocolApi, "fetchAnalysisAttempt").mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("per-page rescan recovery", () => {
  it("does not let a rescan cancelled on page A block page B or page creation", async () => {
    const submit = vi.spyOn(protocolApi, "submitEvaluationTargetRescan")
      .mockImplementationOnce((_id, signal) => stalled(signal!))
      .mockImplementationOnce(async (id) => request(902, id));
    // The abandoned POST never reached the server: background cleanup keeps
    // polling for a receipt, so hold it open for this assertion.
    vi.spyOn(protocolApi, "fetchAnalysisAttempt").mockImplementation((_key, signal) => stalled(signal!));
    const { context } = createContext();

    const controller = new AbortController();
    const pageA = requestTargetAnalysis(context, 101, controller.signal);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pageA).rejects.toMatchObject({ name: "AbortError" });
    expect(readTargetRescanRecovery(101)).toMatchObject({ kind: "valid", attempt: { phase: "request-reconciling" } });

    await expect(requestTargetAnalysis(context, 102)).resolves.toBe(902);
    expect(submit).toHaveBeenLastCalledWith(102, expect.any(AbortSignal), expect.any(String));
    expect(readSiteCreateRecovery()).toEqual({ kind: "none" });
    expect(window.sessionStorage.getItem(getTargetRescanStorageKey(102))).toBeNull();
  });

  it("settles an abandoned rescan in the background with GET only", async () => {
    let releaseReceipt!: (value: EvaluationRequestModel) => void;
    vi.spyOn(protocolApi, "fetchAnalysisAttempt").mockImplementation(() =>
      new Promise((resolve) => { releaseReceipt = resolve; }));
    const submit = vi.spyOn(protocolApi, "submitEvaluationTargetRescan")
      .mockImplementation((_id, signal) => stalled(signal!));
    const { context, loadDashboard } = createContext();

    const controller = new AbortController();
    const pending = requestTargetAnalysis(context, 101, controller.signal);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    await vi.waitFor(() => expect(protocolApi.fetchAnalysisAttempt).toHaveBeenCalled());
    releaseReceipt(request(901, 101));
    await vi.waitFor(() => expect(window.sessionStorage.getItem(getTargetRescanStorageKey(101))).toBeNull());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(loadDashboard).toHaveBeenCalledWith({ background: true, refreshAfterInFlight: true });
  });

  it("does not let a day-old checkpoint block a new rescan", async () => {
    seedRescan(101, { startedAt: Date.now() - 25 * 60 * 60 * 1_000 });
    const submit = vi.spyOn(protocolApi, "submitEvaluationTargetRescan").mockResolvedValue(request(903, 101));
    const { context } = createContext();
    await expect(requestTargetAnalysis(context, 101)).resolves.toBe(903);
    expect(protocolApi.fetchAnalysisAttempt).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(getTargetRescanStorageKey(101))).toBeNull();
  });

  it("starts a new scan when the abandoned rescan has already finished", async () => {
    seedRescan(101);
    vi.spyOn(protocolApi, "fetchAnalysisAttempt").mockResolvedValue(request(900, 101, "COMPLETED"));
    const submit = vi.spyOn(protocolApi, "submitEvaluationTargetRescan").mockResolvedValue(request(904, 101));
    const { context } = createContext();
    await expect(requestTargetAnalysis(context, 101)).resolves.toBe(904);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("attaches to an abandoned rescan that is still running without a second POST", async () => {
    seedRescan(101);
    vi.spyOn(protocolApi, "fetchAnalysisAttempt").mockResolvedValue(request(900, 101, "IN_PROGRESS"));
    const submit = vi.spyOn(protocolApi, "submitEvaluationTargetRescan");
    const { context } = createContext();
    await expect(requestTargetAnalysis(context, 101)).resolves.toBe(900);
    expect(submit).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(getTargetRescanStorageKey(101))).toBeNull();
  });

  it("keeps continuing a page creation in the shared creation slot", async () => {
    const creation = writeSiteCreateRecovery({
      version: 1, attemptId: "creation", apiScope: API_BASE_URL, projectId: 1, name: "Page 102",
      accessUrl: "https://example.com/102", previousTargetIds: [101], startedAt: Date.now(),
      phase: "request-ready", targetId: 102, previousFailedRequestId: null
    }, null);
    expect(creation).not.toBeNull();
    vi.spyOn(protocolApi, "submitEvaluationTargetRescan").mockResolvedValue(request(905, 102));
    const { context } = createContext();
    await expect(requestTargetAnalysis(context, 102)).resolves.toBe(905);
    expect(readSiteCreateRecovery()).toMatchObject({ kind: "valid", attempt: { phase: "poll", requestId: 905 } });
    expect(retireAcceptedTargetAnalysis(102, 905)).toBe(true);
    expect(window.sessionStorage.getItem(SITE_CREATE_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it("leaves unrelated creation work alone when retiring an accepted rescan", () => {
    writeSiteCreateRecovery({
      version: 1, attemptId: "other", apiScope: API_BASE_URL, projectId: 2, name: "Other",
      accessUrl: "https://example.com/other", previousTargetIds: [], startedAt: Date.now(),
      phase: "target-reconciling"
    }, null);
    expect(retireAcceptedTargetAnalysis(101, 906)).toBe(true);
    expect(readSiteCreateRecovery()).toMatchObject({ kind: "valid", attempt: { attemptId: "other" } });
  });
});
