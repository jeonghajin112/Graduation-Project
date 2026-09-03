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
const RESCAN_ATTEMPTS_MAX_LENGTH = 100;

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

export type PersistedTargetRescanAttempt = PersistedAttemptBase & {
  targetId: number;
  knownRequestIds: number[];
} & (
    | { phase: "posting" | "reconciling" }
    | { phase: "known"; requestId: number }
  );

type PersistedTargetRescanAttempts = {
  version: 1;
  apiScope: string;
  attempts: PersistedTargetRescanAttempt[];
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

function normalizeTargetRescanAttempt(
  value: unknown
): PersistedTargetRescanAttempt | null {
  if (!isRecord(value)) {
    return null;
  }
  const base = normalizeAttemptBase(value);
  const knownRequestIds = normalizeRequestIds(value.knownRequestIds);
  if (
    base === null ||
    knownRequestIds === null ||
    !isPositiveSafeInteger(value.targetId)
  ) {
    return null;
  }
  const common = {
    ...base,
    targetId: value.targetId,
    knownRequestIds
  };
  if (value.phase === "posting" || value.phase === "reconciling") {
    return { ...common, phase: value.phase };
  }
  return value.phase === "known" && isPositiveSafeInteger(value.requestId)
    ? { ...common, phase: "known", requestId: value.requestId }
    : null;
}

function normalizeTargetRescanAttempts(
  value: unknown
): PersistedTargetRescanAttempts | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.apiScope !== API_BASE_URL ||
    !Array.isArray(value.attempts) ||
    value.attempts.length === 0 ||
    value.attempts.length > RESCAN_ATTEMPTS_MAX_LENGTH
  ) {
    return null;
  }
  const attempts = value.attempts.map(normalizeTargetRescanAttempt);
  if (attempts.some((attempt) => attempt === null)) {
    return null;
  }
  const validAttempts = attempts as PersistedTargetRescanAttempt[];
  if (
    new Set(validAttempts.map((attempt) => attempt.targetId)).size !== validAttempts.length ||
    new Set(validAttempts.map((attempt) => attempt.attemptId)).size !== validAttempts.length
  ) {
    return null;
  }
  return { version: 1, apiScope: API_BASE_URL, attempts: validAttempts };
}

export function readTargetRescanRecovery(
  now = Date.now()
): RecoveryRead<PersistedTargetRescanAttempt[]> {
  const recovery = readSessionRecovery(
    TARGET_RESCAN_STORAGE_KEY,
    normalizeTargetRescanAttempts
  );
  if (recovery.kind !== "valid") {
    return recovery;
  }
  return recovery.value.attempts.every(
    (attempt) => !isRecoveryTimestampStale(attempt.startedAt, now)
  )
    ? { kind: "valid", rawValue: recovery.rawValue, value: recovery.value.attempts }
    : { kind: "blocked", rawValue: recovery.rawValue };
}

function writeTargetRescanRecord(record: PersistedTargetRescanAttempts): boolean {
  const serializedRecord = JSON.stringify(record);
  window.sessionStorage.setItem(TARGET_RESCAN_STORAGE_KEY, serializedRecord);
  return window.sessionStorage.getItem(TARGET_RESCAN_STORAGE_KEY) === serializedRecord;
}

export function writeTargetRescanAttempt(
  attempt: PersistedTargetRescanAttempt,
  expectedAttemptId: string | null
): boolean {
  try {
    const normalizedAttempt = normalizeTargetRescanAttempt(attempt);
    if (normalizedAttempt === null) {
      return false;
    }
    const currentRawValue = window.sessionStorage.getItem(TARGET_RESCAN_STORAGE_KEY);
    if (currentRawValue === null) {
      if (expectedAttemptId !== null) {
        return false;
      }
      return writeTargetRescanRecord({
        version: 1,
        apiScope: API_BASE_URL,
        attempts: [normalizedAttempt]
      });
    }

    const currentRecord = normalizeTargetRescanAttempts(
      JSON.parse(currentRawValue) as unknown
    );
    if (currentRecord === null) {
      return false;
    }
    const currentIndex = currentRecord.attempts.findIndex(
      (candidate) => candidate.targetId === normalizedAttempt.targetId
    );
    if (expectedAttemptId === null) {
      if (
        currentIndex !== -1 ||
        currentRecord.attempts.length >= RESCAN_ATTEMPTS_MAX_LENGTH
      ) {
        return false;
      }
      currentRecord.attempts.push(normalizedAttempt);
    } else {
      if (
        currentIndex === -1 ||
        currentRecord.attempts[currentIndex]!.attemptId !== expectedAttemptId
      ) {
        return false;
      }
      currentRecord.attempts[currentIndex] = normalizedAttempt;
    }
    return writeTargetRescanRecord(currentRecord);
  } catch {
    return false;
  }
}

export function clearTargetRescanAttempt(
  targetId: number,
  expectedAttemptId: string
): boolean {
  try {
    const currentRawValue = window.sessionStorage.getItem(TARGET_RESCAN_STORAGE_KEY);
    if (currentRawValue === null) {
      return false;
    }
    const currentRecord = normalizeTargetRescanAttempts(
      JSON.parse(currentRawValue) as unknown
    );
    if (currentRecord === null) {
      return false;
    }
    const currentIndex = currentRecord.attempts.findIndex(
      (attempt) => attempt.targetId === targetId
    );
    if (
      currentIndex === -1 ||
      currentRecord.attempts[currentIndex]!.attemptId !== expectedAttemptId
    ) {
      return false;
    }
    currentRecord.attempts.splice(currentIndex, 1);
    if (currentRecord.attempts.length === 0) {
      window.sessionStorage.removeItem(TARGET_RESCAN_STORAGE_KEY);
      return window.sessionStorage.getItem(TARGET_RESCAN_STORAGE_KEY) === null;
    }
    return writeTargetRescanRecord(currentRecord);
  } catch {
    return false;
  }
}
