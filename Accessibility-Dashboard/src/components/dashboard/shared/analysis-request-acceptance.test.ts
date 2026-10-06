import { afterEach, describe, expect, it, vi } from "vitest";

import { API_BASE_URL } from "@/config/api";
import {
  readSiteCreateRecovery,
  writeSiteCreateRecovery,
  type PersistedSiteCreateAttempt
} from "@/services/site-create-recovery-storage";
import {
  persistAcceptedAnalysisRequest,
  recordAcceptedAnalysisRequest
} from "./analysis-request-acceptance";
import { SITE_RECOVERY_PERSISTENCE_MESSAGE } from "./site-create-recovery-workflow";

function installStorage() {
  let raw: string | null = null;
  const storage = {
    getItem: vi.fn(() => raw),
    setItem: vi.fn((_key: string, value: string) => { raw = value; })
  };
  vi.stubGlobal("window", { sessionStorage: storage });
  return storage;
}

function readyAttempt(): Extract<PersistedSiteCreateAttempt, { phase: "request-ready" }> {
  return {
    version: 1,
    attemptId: "acceptance-regression",
    apiScope: API_BASE_URL,
    projectId: 10,
    name: "시험 페이지",
    accessUrl: "https://example.com/",
    previousTargetIds: [20],
    startedAt: Date.now(),
    phase: "request-ready",
    targetId: 20,
    previousFailedRequestId: null
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("analysis request acceptance", () => {
  it("records an existing active request from an unpersisted preparation", () => {
    installStorage();
    const attempt = readyAttempt();
    const stored = persistAcceptedAnalysisRequest({
      attempt, expectedRawValue: null, targetId: 20,
      knownRequestIds: [30, 31], requestId: 31
    });
    expect(stored.attempt).toEqual({
      version: 1, attemptId: attempt.attemptId, apiScope: API_BASE_URL,
      projectId: 10, name: attempt.name, accessUrl: attempt.accessUrl,
      previousTargetIds: [20], startedAt: attempt.startedAt,
      phase: "poll", targetId: 20, knownRequestIds: [30, 31], requestId: 31
    });
    expect(readSiteCreateRecovery()).toMatchObject({
      kind: "valid", attempt: stored.attempt, rawValue: stored.rawValue
    });
    expect(attempt.phase).toBe("request-ready");
  });

  it.each(["request-ready", "request-reconciling"] as const)(
    "advances a stored %s attempt using its original comparison value", (phase) => {
      installStorage();
      const attempt = { ...readyAttempt(), phase, knownRequestIds: [30] };
      const before = writeSiteCreateRecovery(attempt, null)!;
      const after = persistAcceptedAnalysisRequest({
        attempt: before.attempt, expectedRawValue: before.rawValue,
        targetId: 20, knownRequestIds: [30], requestId: 31
      });
      expect(after.attempt.phase).toBe("poll");
      expect(after.attempt.requestId).toBe(31);
      expect(after.attempt.attemptId).toBe(before.attempt.attemptId);
      expect(after.rawValue).not.toBe(before.rawValue);
      expect(readSiteCreateRecovery()).toMatchObject({ kind: "valid", rawValue: after.rawValue });
    }
  );

  it("updates the same checkpoint only after the write is confirmed, retaining resource ownership", () => {
    const storage = installStorage();
    const before = writeSiteCreateRecovery(readyAttempt(), null)!;
    const checkpoint = {
      stored: before, requestId: null as number | null,
      recoveryToken: Symbol("lease"), releaseAbortListener: vi.fn()
    };
    const originalWrite = storage.setItem.getMockImplementation()!;
    storage.setItem.mockImplementation((key, value) => {
      expect(checkpoint.stored).toBe(before);
      expect(checkpoint.requestId).toBeNull();
      originalWrite(key, value);
    });
    const lease = checkpoint.recoveryToken;
    expect(recordAcceptedAnalysisRequest(checkpoint, {
      attempt: before.attempt, expectedRawValue: before.rawValue,
      targetId: 20, knownRequestIds: [30], requestId: 31
    })).toBe(31);
    expect(checkpoint.requestId).toBe(31);
    expect(checkpoint.stored.attempt).toMatchObject({ phase: "poll", requestId: 31 });
    expect(checkpoint.recoveryToken).toBe(lease);
    expect(checkpoint.releaseAbortListener).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer recovery record or accept into memory after a stale write", () => {
    const storage = installStorage();
    const before = writeSiteCreateRecovery(readyAttempt(), null)!;
    const checkpoint = { stored: before, requestId: null };
    const newer = writeSiteCreateRecovery({ ...readyAttempt(), attemptId: "newer-attempt" }, before.rawValue)!;
    storage.setItem.mockClear();
    expect(() => recordAcceptedAnalysisRequest(checkpoint, {
      attempt: before.attempt, expectedRawValue: before.rawValue,
      targetId: 20, knownRequestIds: [30], requestId: 31
    })).toThrow(SITE_RECOVERY_PERSISTENCE_MESSAGE);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(checkpoint).toEqual({ stored: before, requestId: null });
    expect(readSiteCreateRecovery()).toMatchObject({ kind: "valid", rawValue: newer.rawValue });
  });

  it.each(["throws", "does-not-persist"] as const)(
    "leaves the checkpoint unchanged when storage %s", (failure) => {
      const storage = installStorage();
      const before = writeSiteCreateRecovery(readyAttempt(), null)!;
      const checkpoint = { stored: before, requestId: null };
      storage.setItem.mockImplementation(() => {
        if (failure === "throws") throw new Error("Storage unavailable");
      });
      expect(() => recordAcceptedAnalysisRequest(checkpoint, {
        attempt: before.attempt, expectedRawValue: before.rawValue,
        targetId: 20, knownRequestIds: [30], requestId: 31
      })).toThrow(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      expect(checkpoint.stored).toBe(before);
      expect(checkpoint.requestId).toBeNull();
    }
  );

  it("does not bypass storage validation for an invalid accepted ID", () => {
    const storage = installStorage();
    expect(() => persistAcceptedAnalysisRequest({
      attempt: readyAttempt(), expectedRawValue: null,
      targetId: 20, knownRequestIds: [30], requestId: 0
    })).toThrow(SITE_RECOVERY_PERSISTENCE_MESSAGE);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
