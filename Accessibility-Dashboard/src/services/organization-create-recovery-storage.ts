import { API_BASE_URL } from "@/config/api";
import {
  clearSessionRecoveryIfUnchanged,
  clearSessionRecoveryStorage,
  isRecoveryTimestampStale,
  readSessionRecovery
} from "@/services/recovery-storage";
import type { RecoveryRead } from "@/services/recovery-storage";

export const ORGANIZATION_CREATE_STORAGE_KEY =
  "accessibility-dashboard.organization-create-attempt.v1";
export const ORGANIZATION_NAME_MAX_LENGTH = 100;

const PREVIOUS_ORGANIZATION_IDS_MAX_LENGTH = 10_000;

export type PersistedOrganizationCreateAttempt = {
  version: 1;
  attemptId: string;
  apiScope: string;
  name: string;
  previousOrganizationIds: number[];
  startedAt: number;
} & (
  | { phase: "posting" }
  | { phase: "reconciling"; organizationId: number | null }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizePersistedOrganizationCreateAttempt(
  value: unknown
): PersistedOrganizationCreateAttempt | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.attemptId !== "string" ||
    value.attemptId.length === 0 ||
    value.attemptId.length > 100 ||
    value.apiScope !== API_BASE_URL ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    value.name.trim().length > ORGANIZATION_NAME_MAX_LENGTH ||
    !Array.isArray(value.previousOrganizationIds) ||
    value.previousOrganizationIds.length > PREVIOUS_ORGANIZATION_IDS_MAX_LENGTH ||
    !value.previousOrganizationIds.every(
      (id) => Number.isSafeInteger(id) && (id as number) > 0
    ) ||
    new Set(value.previousOrganizationIds).size !== value.previousOrganizationIds.length ||
    !Number.isSafeInteger(value.startedAt) ||
    (value.startedAt as number) <= 0
  ) {
    return null;
  }

  const base = {
    version: 1 as const,
    attemptId: value.attemptId,
    apiScope: API_BASE_URL,
    name: value.name.trim(),
    previousOrganizationIds: value.previousOrganizationIds as number[],
    startedAt: value.startedAt as number
  };
  if (value.phase === "posting") {
    return { ...base, phase: "posting" };
  }
  if (
    value.phase === "reconciling" &&
    (value.organizationId === null ||
      (Number.isSafeInteger(value.organizationId) && (value.organizationId as number) > 0))
  ) {
    return {
      ...base,
      phase: "reconciling",
      organizationId: value.organizationId as number | null
    };
  }

  return null;
}

export function readOrganizationCreateRecovery(): RecoveryRead<PersistedOrganizationCreateAttempt> {
  return readSessionRecovery(
    ORGANIZATION_CREATE_STORAGE_KEY,
    normalizePersistedOrganizationCreateAttempt
  );
}

export function readPersistedOrganizationCreateAttempt(): PersistedOrganizationCreateAttempt | null {
  const recovery = readOrganizationCreateRecovery();
  return recovery.kind === "valid" ? recovery.value : null;
}

export function isPersistedOrganizationCreateAttemptStale(
  attempt: PersistedOrganizationCreateAttempt,
  now = Date.now()
): boolean {
  return isRecoveryTimestampStale(attempt.startedAt, now);
}

export function writePersistedOrganizationCreateAttempt(
  attempt: PersistedOrganizationCreateAttempt,
  expectedAttemptId: string | null
): boolean {
  try {
    const normalizedAttempt = normalizePersistedOrganizationCreateAttempt(attempt);
    if (normalizedAttempt === null) {
      return false;
    }

    const currentRawValue = window.sessionStorage.getItem(ORGANIZATION_CREATE_STORAGE_KEY);
    if (expectedAttemptId === null) {
      if (currentRawValue !== null) {
        return false;
      }
    } else {
      if (currentRawValue === null) {
        return false;
      }
      const currentAttempt = normalizePersistedOrganizationCreateAttempt(
        JSON.parse(currentRawValue) as unknown
      );
      if (currentAttempt?.attemptId !== expectedAttemptId) {
        return false;
      }
    }

    const serializedAttempt = JSON.stringify(normalizedAttempt);
    window.sessionStorage.setItem(ORGANIZATION_CREATE_STORAGE_KEY, serializedAttempt);
    return window.sessionStorage.getItem(ORGANIZATION_CREATE_STORAGE_KEY) === serializedAttempt;
  } catch {
    return false;
  }
}

export function clearPersistedOrganizationCreateAttempt(
  expectedAttemptId?: string
): boolean {
  try {
    const currentRawValue = window.sessionStorage.getItem(ORGANIZATION_CREATE_STORAGE_KEY);
    if (expectedAttemptId !== undefined) {
      if (currentRawValue === null) {
        return false;
      }
      const currentAttempt = normalizePersistedOrganizationCreateAttempt(
        JSON.parse(currentRawValue) as unknown
      );
      if (currentAttempt?.attemptId !== expectedAttemptId) {
        return false;
      }
    }

    window.sessionStorage.removeItem(ORGANIZATION_CREATE_STORAGE_KEY);
    return window.sessionStorage.getItem(ORGANIZATION_CREATE_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

export function clearBlockedOrganizationCreateRecovery(expectedRawValue: string): boolean {
  return clearSessionRecoveryIfUnchanged(
    ORGANIZATION_CREATE_STORAGE_KEY,
    expectedRawValue
  );
}

export function clearOrganizationCreateRecoveryStorage(): void {
  clearSessionRecoveryStorage(ORGANIZATION_CREATE_STORAGE_KEY);
}
