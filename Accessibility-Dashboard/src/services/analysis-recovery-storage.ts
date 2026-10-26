import { API_BASE_URL } from "@/config/api";
import {
  clearSessionRecoveryIfUnchanged,
  clearSessionRecoveryStorage,
  clearSessionRecoveryStorageByPrefix,
  isRecoveryAttemptId,
  isRecoveryTimestampStale,
  isUuid,
  readSessionRecovery,
  writeSessionRecoveryIfUnchanged
} from "@/services/recovery-storage";
import type { RecoveryRead, RecoveryWriteFailure } from "@/services/recovery-storage";
import { isObjectRecord, isPositiveSafeInteger } from "@/lib/guards";

export const QUICK_ANALYSIS_STORAGE_KEY =
  "accessibility-dashboard.quick-analysis-attempt.v1";
export const TARGET_RESCAN_STORAGE_KEY =
  "accessibility-dashboard.target-rescan-attempts.v1";

/** Each existing page owns its rescan checkpoint, so one page never locks another. */
export function getTargetRescanStorageKey(targetId: number): string {
  return `${TARGET_RESCAN_STORAGE_KEY}:${targetId}`;
}

export function clearAnalysisRecoveryStorage(): void {
  clearSessionRecoveryStorage(QUICK_ANALYSIS_STORAGE_KEY);
  // Also removes the legacy shared key.
  clearSessionRecoveryStorageByPrefix(TARGET_RESCAN_STORAGE_KEY);
}

const URL_MAX_LENGTH = 4096;
const STATUS_MAX_LENGTH = 100;
export const REQUEST_IDS_MAX_LENGTH = 10_000;

type PersistedAttemptBase = {
  attemptId: string;
  apiScope: string;
  startedAt: number;
};

export type PersistedQuickAnalysisAttempt = PersistedAttemptBase & {
  version: 1;
  url: string;
} & (
    | {
        phase: "posting" | "reconciling";
        knownRequestIds: number[];
        serverKey?: true;
      }
    | {
        phase: "request";
        requestId: number;
        targetId: number | null;
        status: string | null;
        updatedAt: string | null;
      }
    | {
        phase: "target";
        requestId: number;
        targetId: number;
        updatedAt: string | null;
      }
  );

type QuickAnalysisAttemptCommon = PersistedAttemptBase & {
  version: 1;
  url: string;
};

export type StoredQuickAnalysisAttempt = {
  attempt: PersistedQuickAnalysisAttempt;
  rawValue: string;
};

function normalizeAttemptBase(
  value: Record<string, unknown>
): PersistedAttemptBase | null {
  if (
    !isRecoveryAttemptId(value.attemptId) ||
    value.apiScope !== API_BASE_URL ||
    !isPositiveSafeInteger(value.startedAt)
  ) {
    return null;
  }

  return {
    attemptId: value.attemptId,
    apiScope: API_BASE_URL,
    startedAt: value.startedAt as number
  };
}

function normalizeRequestIds(value: unknown): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length > REQUEST_IDS_MAX_LENGTH ||
    !value.every(isPositiveSafeInteger) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value as number[];
}

function normalizeNullableShortString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length > STATUS_MAX_LENGTH) {
    return undefined;
  }
  return value;
}

function isHttpAttemptUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > URL_MAX_LENGTH) {
    return false;
  }
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeRequestIdsPhase(
  value: Record<string, unknown>,
  common: QuickAnalysisAttemptCommon,
  phase: "posting" | "reconciling"
): PersistedQuickAnalysisAttempt | null {
  if (value.serverKey !== undefined && (value.serverKey !== true || !isUuid(common.attemptId))) return null;
  const knownRequestIds = normalizeRequestIds(value.knownRequestIds);
  return knownRequestIds === null
    ? null
    : { ...common, phase, knownRequestIds, ...(value.serverKey === true ? { serverKey: true as const } : {}) };
}

function normalizeRequestPhase(
  value: Record<string, unknown>,
  common: QuickAnalysisAttemptCommon
): PersistedQuickAnalysisAttempt | null {
  if (!isPositiveSafeInteger(value.requestId)) {
    return null;
  }
  const targetId = value.targetId === null
    ? null
    : isPositiveSafeInteger(value.targetId)
      ? value.targetId
      : undefined;
  const status = normalizeNullableShortString(value.status);
  const updatedAt = normalizeNullableShortString(value.updatedAt);
  return targetId === undefined || status === undefined || updatedAt === undefined
    ? null
    : {
        ...common,
        phase: "request",
        requestId: value.requestId,
        targetId,
        status,
        updatedAt
      };
}

function normalizeTargetPhase(
  value: Record<string, unknown>,
  common: QuickAnalysisAttemptCommon
): PersistedQuickAnalysisAttempt | null {
  if (!isPositiveSafeInteger(value.requestId) || !isPositiveSafeInteger(value.targetId)) {
    return null;
  }
  const updatedAt = normalizeNullableShortString(value.updatedAt);
  return updatedAt === undefined
    ? null
    : {
        ...common,
        phase: "target",
        requestId: value.requestId,
        targetId: value.targetId,
        updatedAt
      };
}

function normalizeQuickAnalysisAttempt(
  value: unknown
): PersistedQuickAnalysisAttempt | null {
  if (!isObjectRecord(value) || value.version !== 1) {
    return null;
  }
  const base = normalizeAttemptBase(value);
  if (base === null || !isHttpAttemptUrl(value.url)) {
    return null;
  }

  const common: QuickAnalysisAttemptCommon = {
    version: 1,
    ...base,
    url: value.url
  };
  switch (value.phase) {
    case "posting":
    case "reconciling":
      return normalizeRequestIdsPhase(value, common, value.phase);
    case "request":
      return normalizeRequestPhase(value, common);
    case "target":
      return normalizeTargetPhase(value, common);
    default:
      return null;
  }
}

export function readQuickAnalysisRecovery(
  now = Date.now()
): RecoveryRead<PersistedQuickAnalysisAttempt> {
  const recovery = readSessionRecovery(
    QUICK_ANALYSIS_STORAGE_KEY,
    normalizeQuickAnalysisAttempt
  );
  return recovery.kind === "valid" &&
    isRecoveryTimestampStale(recovery.value.startedAt, now)
    ? { kind: "blocked", rawValue: recovery.rawValue }
    : recovery;
}

export function writeQuickAnalysisAttempt(
  attempt: PersistedQuickAnalysisAttempt,
  expectedRawValue: string | null,
  onFailure?: (reason: RecoveryWriteFailure) => void
): StoredQuickAnalysisAttempt | null {
  const stored = writeSessionRecoveryIfUnchanged(
    QUICK_ANALYSIS_STORAGE_KEY,
    attempt,
    normalizeQuickAnalysisAttempt,
    expectedRawValue,
    onFailure
  );
  if (stored === null) {
    return null;
  }
  return { attempt: stored.value, rawValue: stored.rawValue };
}

export function clearQuickAnalysisAttempt(expectedRawValue: string): boolean {
  return clearSessionRecoveryIfUnchanged(
    QUICK_ANALYSIS_STORAGE_KEY,
    expectedRawValue
  );
}
