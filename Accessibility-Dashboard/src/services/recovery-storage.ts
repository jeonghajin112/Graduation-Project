export const RECOVERY_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
export const RECOVERY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type RecoveryRead<T> =
  | { kind: "none" }
  | { kind: "valid"; rawValue: string; value: T }
  | { kind: "blocked"; rawValue: string | null };

export function isRecoveryTimestampStale(
  startedAt: number,
  now = Date.now()
): boolean {
  return (
    startedAt < now - RECOVERY_STALE_AFTER_MS ||
    startedAt > now + RECOVERY_MAX_FUTURE_SKEW_MS
  );
}

export function readSessionRecovery<T>(
  storageKey: string,
  normalize: (value: unknown) => T | null
): RecoveryRead<T> {
  try {
    const rawValue = window.sessionStorage.getItem(storageKey);
    if (rawValue === null) {
      return { kind: "none" };
    }
    const value = normalize(JSON.parse(rawValue) as unknown);
    return value === null
      ? { kind: "blocked", rawValue }
      : { kind: "valid", rawValue, value };
  } catch {
    try {
      return {
        kind: "blocked",
        rawValue: window.sessionStorage.getItem(storageKey)
      };
    } catch {
      return { kind: "blocked", rawValue: null };
    }
  }
}

export function clearSessionRecoveryStorage(storageKey: string): void {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Logout must remain available when storage is blocked by the browser.
  }
}

export function clearSessionRecoveryIfUnchanged(
  storageKey: string,
  expectedRawValue: string
): boolean {
  try {
    if (window.sessionStorage.getItem(storageKey) !== expectedRawValue) {
      return false;
    }
    window.sessionStorage.removeItem(storageKey);
    return window.sessionStorage.getItem(storageKey) === null;
  } catch {
    return false;
  }
}
