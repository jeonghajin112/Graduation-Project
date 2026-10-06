import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE_URL } from "@/config/api";
import { readQuickAnalysisRecovery, writeQuickAnalysisAttempt } from "./analysis-recovery-storage";
import { writeSessionRecoveryIfUnchanged } from "./recovery-storage";

function storage() {
  let raw: string | null = null;
  const sessionStorage = { getItem: vi.fn(() => raw), setItem: vi.fn((_key: string, value: string) => { raw = value; }), removeItem: vi.fn(() => { raw = null; }) };
  vi.stubGlobal("window", { sessionStorage });
  return sessionStorage;
}
afterEach(() => vi.unstubAllGlobals());
describe("analysis recovery boundaries", () => {
  const attempt = { version: 1 as const, attemptId: "a3f68190-c100-4b23-a584-545b6a7e1943", startedAt: Date.now(), apiScope: API_BASE_URL,
    url: "https://example.com/", phase: "posting" as const, knownRequestIds: [] as number[] };
  it.each([9999, 10000, 10001])("preserves the legacy complete baseline at %s IDs", count => {
    storage();
    const result = writeQuickAnalysisAttempt({ ...attempt, knownRequestIds: Array.from({ length: count }, (_, index) => index + 1) }, null);
    expect(result !== null).toBe(count <= 10000);
    if (result) expect(result.attempt.phase === "posting" && result.attempt.knownRequestIds.length).toBe(count);
  });
  it("persists a server key without historical IDs and rejects malformed key metadata", () => {
    storage();
    expect(writeQuickAnalysisAttempt({ ...attempt, serverKey: true }, null)).not.toBeNull();
    const restored = readQuickAnalysisRecovery();
    expect(restored.kind === "valid" && restored.value).toMatchObject({ serverKey: true, knownRequestIds: [] });
    storage();
    expect(writeQuickAnalysisAttempt({ ...attempt, attemptId: "bad", serverKey: true }, null)).toBeNull();
  });
  it("distinguishes quota, access failure and invalid payload without overwriting recovery", () => {
    const store = storage();
    const onFailure = vi.fn();
    store.setItem.mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    expect(writeQuickAnalysisAttempt(attempt, null, onFailure)).toBeNull();
    expect(onFailure).toHaveBeenLastCalledWith("quota");
    store.getItem.mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    expect(writeQuickAnalysisAttempt(attempt, null, onFailure)).toBeNull();
    expect(onFailure).toHaveBeenLastCalledWith("unavailable");
    expect(writeSessionRecoveryIfUnchanged("key", {}, () => null, null, onFailure)).toBeNull();
    expect(onFailure).toHaveBeenLastCalledWith("invalid");
  });
});
