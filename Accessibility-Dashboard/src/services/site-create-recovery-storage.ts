import { API_BASE_URL } from "@/config/api";

export const SITE_CREATE_RECOVERY_STORAGE_KEY =
  "accessibility-dashboard.site-create-attempt.v1";

const SITE_NAME_MAX_LENGTH = 100;
const SITE_URL_MAX_LENGTH = 2_048;
const ID_LIST_MAX_LENGTH = 10_000;
const RECOVERY_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const RECOVERY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

type SiteCreateRecoveryBase = {
  version: 1;
  attemptId: string;
  apiScope: string;
  projectId: number;
  name: string;
  accessUrl: string;
  previousTargetIds: number[];
  startedAt: number;
};

export type PersistedSiteCreateAttempt = SiteCreateRecoveryBase &
  (
    | { phase: "target-reconciling" }
    | {
        phase: "request-ready";
        targetId: number;
        previousFailedRequestId: number | null;
      }
    | {
        phase: "request-reconciling";
        targetId: number;
        knownRequestIds: number[];
        previousFailedRequestId: number | null;
      }
    | {
        phase: "poll";
        targetId: number;
        knownRequestIds: number[];
        requestId: number;
      }
  );

export type SiteCreateRecoveryReadResult =
  | { kind: "none" }
  | {
      kind: "valid";
      attempt: PersistedSiteCreateAttempt;
      rawValue: string;
      isStale: boolean;
    }
  | { kind: "blocked"; rawValue: string | null };

export type StoredSiteCreateAttempt = {
  attempt: PersistedSiteCreateAttempt;
  rawValue: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isPositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function normalizeIdList(value: unknown): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length > ID_LIST_MAX_LENGTH ||
    !value.every(isPositiveId) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value as number[];
}

export function normalizeSiteCreateAccessUrl(value: string): string {
  try {
    return new URL(value.trim()).href;
  } catch {
    return value.trim();
  }
}

function normalizePersistedSiteCreateAttempt(
  value: unknown
): PersistedSiteCreateAttempt | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  const accessUrl =
    typeof value.accessUrl === "string"
      ? normalizeSiteCreateAccessUrl(value.accessUrl)
      : "";
  const previousTargetIds = normalizeIdList(value.previousTargetIds);
  if (
    value.version !== 1 ||
    typeof value.attemptId !== "string" ||
    value.attemptId.length === 0 ||
    value.attemptId.length > 100 ||
    value.apiScope !== API_BASE_URL ||
    !isPositiveId(value.projectId) ||
    name.length === 0 ||
    name.length > SITE_NAME_MAX_LENGTH ||
    accessUrl.length === 0 ||
    accessUrl.length > SITE_URL_MAX_LENGTH ||
    previousTargetIds === null ||
    !Number.isSafeInteger(value.startedAt) ||
    (value.startedAt as number) <= 0
  ) {
    return null;
  }

  const base: SiteCreateRecoveryBase = {
    version: 1,
    attemptId: value.attemptId,
    apiScope: API_BASE_URL,
    projectId: value.projectId,
    name,
    accessUrl,
    previousTargetIds,
    startedAt: value.startedAt as number
  };

  if (value.phase === "target-reconciling") {
    return { ...base, phase: "target-reconciling" };
  }

  if (value.phase === "request-ready" && isPositiveId(value.targetId)) {
    if (
      value.previousFailedRequestId !== null &&
      !isPositiveId(value.previousFailedRequestId)
    ) {
      return null;
    }
    return {
      ...base,
      phase: "request-ready",
      targetId: value.targetId,
      previousFailedRequestId: value.previousFailedRequestId as number | null
    };
  }

  if (value.phase === "request-reconciling" && isPositiveId(value.targetId)) {
    const knownRequestIds = normalizeIdList(value.knownRequestIds);
    if (
      knownRequestIds === null ||
      (value.previousFailedRequestId !== null &&
        !isPositiveId(value.previousFailedRequestId))
    ) {
      return null;
    }
    return {
      ...base,
      phase: "request-reconciling",
      targetId: value.targetId,
      knownRequestIds,
      previousFailedRequestId: value.previousFailedRequestId as number | null
    };
  }

  if (value.phase === "poll" && isPositiveId(value.targetId)) {
    const knownRequestIds = normalizeIdList(value.knownRequestIds);
    if (knownRequestIds === null || !isPositiveId(value.requestId)) {
      return null;
    }
    return {
      ...base,
      phase: "poll",
      targetId: value.targetId,
      knownRequestIds,
      requestId: value.requestId
    };
  }

  return null;
}

export function isSiteCreateAttemptStale(
  attempt: PersistedSiteCreateAttempt,
  now = Date.now()
): boolean {
  return (
    attempt.startedAt < now - RECOVERY_STALE_AFTER_MS ||
    attempt.startedAt > now + RECOVERY_MAX_FUTURE_SKEW_MS
  );
}

export function readSiteCreateRecovery(): SiteCreateRecoveryReadResult {
  try {
    const rawValue = window.sessionStorage.getItem(SITE_CREATE_RECOVERY_STORAGE_KEY);
    if (rawValue === null) {
      return { kind: "none" };
    }

    const attempt = normalizePersistedSiteCreateAttempt(
      JSON.parse(rawValue) as unknown
    );
    if (attempt === null) {
      return { kind: "blocked", rawValue };
    }
    return {
      kind: "valid",
      attempt,
      rawValue,
      isStale: isSiteCreateAttemptStale(attempt)
    };
  } catch {
    try {
      return {
        kind: "blocked",
        rawValue: window.sessionStorage.getItem(SITE_CREATE_RECOVERY_STORAGE_KEY)
      };
    } catch {
      return { kind: "blocked", rawValue: null };
    }
  }
}

export function writeSiteCreateRecovery(
  attempt: PersistedSiteCreateAttempt,
  expectedRawValue: string | null
): StoredSiteCreateAttempt | null {
  try {
    const normalizedAttempt = normalizePersistedSiteCreateAttempt(attempt);
    if (normalizedAttempt === null) {
      return null;
    }
    if (
      window.sessionStorage.getItem(SITE_CREATE_RECOVERY_STORAGE_KEY) !==
      expectedRawValue
    ) {
      return null;
    }

    const rawValue = JSON.stringify(normalizedAttempt);
    window.sessionStorage.setItem(SITE_CREATE_RECOVERY_STORAGE_KEY, rawValue);
    if (window.sessionStorage.getItem(SITE_CREATE_RECOVERY_STORAGE_KEY) !== rawValue) {
      return null;
    }
    return { attempt: normalizedAttempt, rawValue };
  } catch {
    return null;
  }
}

export function clearSiteCreateRecovery(
  expectedRawValue: string
): boolean {
  try {
    if (
      window.sessionStorage.getItem(SITE_CREATE_RECOVERY_STORAGE_KEY) !==
      expectedRawValue
    ) {
      return false;
    }
    window.sessionStorage.removeItem(SITE_CREATE_RECOVERY_STORAGE_KEY);
    return window.sessionStorage.getItem(SITE_CREATE_RECOVERY_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

export function clearSiteCreateRecoveryStorage(): void {
  try {
    window.sessionStorage.removeItem(SITE_CREATE_RECOVERY_STORAGE_KEY);
  } catch {
    // Logout must remain available when storage is blocked by the browser.
  }
}
