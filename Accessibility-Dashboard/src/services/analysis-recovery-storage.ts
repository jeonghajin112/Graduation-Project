import { API_BASE_URL } from "@/config/api";
import {
  clearSessionRecoveryIfUnchanged,
  clearSessionRecoveryStorage,
  isRecoveryTimestampStale,
  readSessionRecovery,
  writeSessionRecoveryIfUnchanged
} from "@/services/recovery-storage";
import type { RecoveryRead } from "@/services/recovery-storage";

export const QUICK_ANALYSIS_STORAGE_KEY =
  "accessibility-dashboard.quick-analysis-attempt.v1";
export const TARGET_RESCAN_STORAGE_KEY =
  "accessibility-dashboard.target-rescan-attempts.v1";

export function clearAnalysisRecoveryStorage(): void {
  clearSessionRecoveryStorage(QUICK_ANALYSIS_STORAGE_KEY);
  clearSessionRecoveryStorage(TARGET_RESCAN_STORAGE_KEY);
}

const ATTEMPT_ID_MAX_LENGTH = 100;
const URL_MAX_LENGTH = 4096;
const STATUS_MAX_LENGTH = 100;
const REQUEST_IDS_MAX_LENGTH = 10_000;

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

export type StoredQuickAnalysisAttempt = {
  attempt: PersistedQuickAnalysisAttempt;
  rawValue: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function normalizeAttemptBase(
  value: Record<string, unknown>
): PersistedAttemptBase | null {
  if (
    typeof value.attemptId !== "string" ||
    value.attemptId.length === 0 ||
    value.attemptId.length > ATTEMPT_ID_MAX_LENGTH ||
    value.apiScope !== API_BASE_URL ||
    !Number.isSafeInteger(value.startedAt) ||
    (value.startedAt as number) <= 0
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

function normalizeQuickAnalysisAttempt(
  value: unknown
): PersistedQuickAnalysisAttempt | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const base = normalizeAttemptBase(value);
  if (
    base === null ||
    typeof value.url !== "string" ||
    value.url.length === 0 ||
    value.url.length > URL_MAX_LENGTH
  ) {
    return null;
  }
  try {
    const parsedUrl = new URL(value.url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  const common = {
    version: 1 as const,
    ...base,
    url: value.url
  };
  if (value.phase === "posting" || value.phase === "reconciling") {
    const knownRequestIds = normalizeRequestIds(value.knownRequestIds);
    return knownRequestIds === null
      ? null
      : { ...common, phase: value.phase, knownRequestIds };
  }
  if (value.phase === "request" && isPositiveSafeInteger(value.requestId)) {
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
  if (
    value.phase === "target" &&
    isPositiveSafeInteger(value.requestId) &&
    isPositiveSafeInteger(value.targetId)
  ) {
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
  return null;
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
  expectedRawValue: string | null
): StoredQuickAnalysisAttempt | null {
  const stored = writeSessionRecoveryIfUnchanged(
    QUICK_ANALYSIS_STORAGE_KEY,
    attempt,
    normalizeQuickAnalysisAttempt,
    expectedRawValue
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
