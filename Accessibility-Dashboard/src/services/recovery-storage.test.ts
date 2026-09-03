import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECOVERY_MAX_FUTURE_SKEW_MS,
  RECOVERY_STALE_AFTER_MS,
  clearSessionRecoveryIfUnchanged,
  isRecoveryTimestampStale,
  readSessionRecovery,
  writeSessionRecoveryIfUnchanged
} from "./recovery-storage";

function installSessionStorage(rawValue: string | null) {
  let currentRawValue = rawValue;
  const storage = {
    getItem: vi.fn(() => currentRawValue),
    removeItem: vi.fn(() => {
      currentRawValue = null;
    }),
    setItem: vi.fn((_key: string, value: string) => {
      currentRawValue = value;
    })
  };
  vi.stubGlobal("window", {
    sessionStorage: storage
  });
  return storage;
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

describe("raw-value recovery compare-and-swap", () => {
  const normalize = (value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("phase" in value) ||
      typeof value.phase !== "string"
    ) {
      return null;
    }
    return { phase: value.phase };
  };

  it("creates and advances only from the exact serialized phase", () => {
    installSessionStorage(null);
    const created = writeSessionRecoveryIfUnchanged(
      "recovery-key",
      { phase: "posting" },
      normalize,
      null
    );
    expect(created).toEqual({
      rawValue: '{"phase":"posting"}',
      value: { phase: "posting" }
    });

    const advanced = writeSessionRecoveryIfUnchanged(
      "recovery-key",
      { phase: "reconciling" },
      normalize,
      created!.rawValue
    );
    expect(advanced?.rawValue).toBe('{"phase":"reconciling"}');
  });

  it("rejects stale writers and stale clears from the same attempt", () => {
    const storage = installSessionStorage('{"phase":"reconciling"}');
    expect(
      writeSessionRecoveryIfUnchanged(
        "recovery-key",
        { phase: "posting" },
        normalize,
        '{"phase":"posting"}'
      )
    ).toBeNull();
    expect(clearSessionRecoveryIfUnchanged("recovery-key", '{"phase":"posting"}')).toBe(
      false
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
