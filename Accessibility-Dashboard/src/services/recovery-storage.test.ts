import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECOVERY_MAX_FUTURE_SKEW_MS,
  RECOVERY_STALE_AFTER_MS,
  isRecoveryTimestampStale,
  readSessionRecovery
} from "./recovery-storage";

function installSessionStorage(rawValue: string | null): void {
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: vi.fn(() => rawValue),
      removeItem: vi.fn(),
      setItem: vi.fn()
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recovery timestamp policy", () => {
  const now = 2_000_000_000_000;

  it("shares inclusive boundaries across every recovery workflow", () => {
    expect(isRecoveryTimestampStale(now - RECOVERY_STALE_AFTER_MS, now)).toBe(false);
    expect(isRecoveryTimestampStale(now - RECOVERY_STALE_AFTER_MS - 1, now)).toBe(true);
    expect(isRecoveryTimestampStale(now + RECOVERY_MAX_FUTURE_SKEW_MS, now)).toBe(false);
    expect(isRecoveryTimestampStale(now + RECOVERY_MAX_FUTURE_SKEW_MS + 1, now)).toBe(true);
  });
});

describe("readSessionRecovery", () => {
  it("returns none when no recovery record exists", () => {
    installSessionStorage(null);
    expect(readSessionRecovery("recovery-key", () => ({ id: 1 }))).toEqual({ kind: "none" });
  });

  it("returns the normalized value and compare-and-swap raw value", () => {
    installSessionStorage('{"id":1}');
    expect(
      readSessionRecovery("recovery-key", (value) =>
        typeof value === "object" && value !== null ? { id: 1 } : null
      )
    ).toEqual({ kind: "valid", rawValue: '{"id":1}', value: { id: 1 } });
  });

  it.each(["malformed-json", "{}"])("blocks malformed recovery data: %s", (rawValue) => {
    installSessionStorage(rawValue);
    expect(readSessionRecovery("recovery-key", () => null)).toEqual({
      kind: "blocked",
      rawValue
    });
  });
});
