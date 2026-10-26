import { API_BASE_URL } from "@/config/api";
import { getTargetRescanStorageKey } from "@/services/analysis-recovery-storage";
import {
  clearSessionRecoveryIfUnchanged,
  clearSessionRecoveryStorage,
  isRecoveryAttemptId,
  isRecoveryTimestampStale,
  isUuid,
  readSessionRecovery,
  writeSessionRecoveryIfUnchanged
} from "@/services/recovery-storage";
import { isObjectRecord } from "@/lib/guards";

export const SITE_CREATE_RECOVERY_STORAGE_KEY =
  "accessibility-dashboard.site-create-attempt.v1";

export const SITE_NAME_MAX_LENGTH = 100;
export const SITE_URL_MAX_LENGTH = 500;
const ID_LIST_MAX_LENGTH = 10_000;

type SiteCreateRecoveryBase = {
  analysisKey?: string;
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

function isPreviousFailedRequestId(value: unknown): value is number | null {
  return value === null || isPositiveId(value);
}

function normalizeSiteCreatePage(
  value: Record<string, unknown>
): { name: string; accessUrl: string } | null {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const accessUrl =
    typeof value.accessUrl === "string"
      ? normalizeSiteCreateAccessUrl(value.accessUrl)
      : "";
  if (
    name.length === 0 ||
    name.length > SITE_NAME_MAX_LENGTH ||
    !isValidEvaluationTargetAccessUrl(accessUrl)
  ) {
    return null;
  }
  return { name, accessUrl };
}

function normalizeSiteCreateBase(
  value: Record<string, unknown>
): SiteCreateRecoveryBase | null {
  const page = normalizeSiteCreatePage(value);
  const previousTargetIds = normalizeIdList(value.previousTargetIds);
  if (
    value.version !== 1 ||
    !isRecoveryAttemptId(value.attemptId) ||
    value.apiScope !== API_BASE_URL ||
    !isPositiveId(value.projectId) ||
    page === null ||
    previousTargetIds === null ||
    !isPositiveId(value.startedAt)
  ) {
    return null;
  }

  return {
    ...(isUuid(value.analysisKey) ? { analysisKey: value.analysisKey } : {}),
    version: 1,
    attemptId: value.attemptId,
    apiScope: API_BASE_URL,
    projectId: value.projectId,
    name: page.name,
    accessUrl: page.accessUrl,
    previousTargetIds,
    startedAt: value.startedAt
  };
}

function normalizeRequestReadyPhase(
  value: Record<string, unknown>,
  base: SiteCreateRecoveryBase
): PersistedSiteCreateAttempt | null {
  if (!isPositiveId(value.targetId) || !isPreviousFailedRequestId(value.previousFailedRequestId)) {
    return null;
  }
  return {
    ...base,
    phase: "request-ready",
    targetId: value.targetId,
    previousFailedRequestId: value.previousFailedRequestId
  };
}

function normalizeRequestReconcilingPhase(
  value: Record<string, unknown>,
  base: SiteCreateRecoveryBase
): PersistedSiteCreateAttempt | null {
  const knownRequestIds = normalizeIdList(value.knownRequestIds);
  if (
    !isPositiveId(value.targetId) ||
    knownRequestIds === null ||
    !isPreviousFailedRequestId(value.previousFailedRequestId)
  ) {
    return null;
  }
  return {
    ...base,
    phase: "request-reconciling",
    targetId: value.targetId,
    knownRequestIds,
    previousFailedRequestId: value.previousFailedRequestId
  };
}

function normalizePollPhase(
  value: Record<string, unknown>,
  base: SiteCreateRecoveryBase
): PersistedSiteCreateAttempt | null {
  const knownRequestIds = normalizeIdList(value.knownRequestIds);
  if (!isPositiveId(value.targetId) || knownRequestIds === null || !isPositiveId(value.requestId)) {
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

function normalizePersistedSiteCreateAttempt(
  value: unknown
): PersistedSiteCreateAttempt | null {
  if (!isObjectRecord(value) || (value.analysisKey !== undefined && !isUuid(value.analysisKey))) {
    return null;
  }
  const base = normalizeSiteCreateBase(value);
  if (base === null) {
    return null;
  }

  switch (value.phase) {
    case "target-reconciling":
      return { ...base, phase: "target-reconciling" };
    case "request-ready":
      return normalizeRequestReadyPhase(value, base);
    case "request-reconciling":
      return normalizeRequestReconcilingPhase(value, base);
    case "poll":
      return normalizePollPhase(value, base);
    default:
      return null;
  }
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

function normalizeTargetRescanAttempt(targetId: number) {
  return (value: unknown): PersistedSiteCreateAttempt | null => {
    const attempt = normalizePersistedSiteCreateAttempt(value);
    return attempt !== null && getAttemptTargetId(attempt) === targetId ? attempt : null;
  };
}

function getAttemptTargetId(attempt: PersistedSiteCreateAttempt): number | null {
  return attempt.phase === "target-reconciling" ? null : attempt.targetId;
}

/**
 * Rescans of an existing page use a per-target slot instead of the single
 * page-creation slot. A cancelled rescan on page A therefore never blocks a
 * rescan of page B or a new page creation.
 */
export function readTargetRescanRecovery(targetId: number): SiteCreateRecoveryReadResult {
  const recovery = readSessionRecovery(
    getTargetRescanStorageKey(targetId),
    normalizeTargetRescanAttempt(targetId)
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

export function writeTargetRescanRecovery(
  attempt: PersistedSiteCreateAttempt,
  expectedRawValue: string | null
): StoredSiteCreateAttempt | null {
  const targetId = getAttemptTargetId(attempt);
  if (targetId === null) {
    return null;
  }
  const stored = writeSessionRecoveryIfUnchanged(
    getTargetRescanStorageKey(targetId),
    attempt,
    normalizeTargetRescanAttempt(targetId),
    expectedRawValue
  );
  if (stored === null) {
    return null;
  }
  return { attempt: stored.value, rawValue: stored.rawValue };
}

export function clearTargetRescanRecovery(targetId: number, expectedRawValue: string): boolean {
  return clearSessionRecoveryIfUnchanged(getTargetRescanStorageKey(targetId), expectedRawValue);
}

/**
 * Retires the page-creation checkpoint of an accepted request, and only that
 * one. A rescan retires its own per-page checkpoint inside the request flow,
 * and unrelated creation work (another page or project) stays untouched.
 * Returns false only when this request's checkpoint could not be removed.
 */
export function retireAcceptedTargetAnalysis(targetId: number, requestId: number): boolean {
  const recovery = readSiteCreateRecovery();
  if (
    recovery.kind !== "valid" ||
    recovery.attempt.phase !== "poll" ||
    recovery.attempt.targetId !== targetId ||
    recovery.attempt.requestId !== requestId
  ) {
    return true;
  }
  return clearSiteCreateRecovery(recovery.rawValue);
}
