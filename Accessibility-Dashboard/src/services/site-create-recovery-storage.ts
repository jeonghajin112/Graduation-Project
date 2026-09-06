import { API_BASE_URL } from "@/config/api";
import {
  clearSessionRecoveryIfUnchanged,
  clearSessionRecoveryStorage,
  isRecoveryTimestampStale,
  readSessionRecovery,
  writeSessionRecoveryIfUnchanged
} from "@/services/recovery-storage";

export const SITE_CREATE_RECOVERY_STORAGE_KEY =
  "accessibility-dashboard.site-create-attempt.v1";

export const SITE_NAME_MAX_LENGTH = 100;
export const SITE_URL_MAX_LENGTH = 500;
const ID_LIST_MAX_LENGTH = 10_000;

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
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) {
      return parsed.href;
    }
  } catch {
    // Return the trimmed input so the caller can present a validation error.
  }
  return trimmed;
}

export function isValidEvaluationTargetAccessUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SITE_URL_MAX_LENGTH) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.href.length <= SITE_URL_MAX_LENGTH
    );
  } catch {
    return false;
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
    !isValidEvaluationTargetAccessUrl(accessUrl) ||
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
  return isRecoveryTimestampStale(attempt.startedAt, now);
}

export function readSiteCreateRecovery(): SiteCreateRecoveryReadResult {
  const recovery = readSessionRecovery(
    SITE_CREATE_RECOVERY_STORAGE_KEY,
    normalizePersistedSiteCreateAttempt
  );
  if (recovery.kind !== "valid") {
    return recovery;
  }
  return {
    kind: "valid",
    attempt: recovery.value,
    rawValue: recovery.rawValue,
    isStale: isSiteCreateAttemptStale(recovery.value)
  };
}

export function writeSiteCreateRecovery(
  attempt: PersistedSiteCreateAttempt,
  expectedRawValue: string | null
): StoredSiteCreateAttempt | null {
  const stored = writeSessionRecoveryIfUnchanged(
    SITE_CREATE_RECOVERY_STORAGE_KEY,
    attempt,
    normalizePersistedSiteCreateAttempt,
    expectedRawValue
  );
  if (stored === null) {
    return null;
  }
  return { attempt: stored.value, rawValue: stored.rawValue };
}

export function clearSiteCreateRecovery(
  expectedRawValue: string
): boolean {
  return clearSessionRecoveryIfUnchanged(
    SITE_CREATE_RECOVERY_STORAGE_KEY,
    expectedRawValue
  );
}

export function clearSiteCreateRecoveryStorage(): void {
  clearSessionRecoveryStorage(SITE_CREATE_RECOVERY_STORAGE_KEY);
}
