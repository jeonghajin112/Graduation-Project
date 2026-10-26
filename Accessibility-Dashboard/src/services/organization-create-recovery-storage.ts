import { API_BASE_URL } from "@/config/api";
import {
  clearSessionRecoveryIfUnchanged,
  clearSessionRecoveryStorage,
  isRecoveryTimestampStale,
  isUuid,
  readSessionRecovery,
  writeSessionRecoveryIfUnchanged
} from "@/services/recovery-storage";
import type { RecoveryRead } from "@/services/recovery-storage";
import { isObjectRecord, isPositiveSafeInteger } from "@/lib/guards";

export const ORGANIZATION_CREATE_STORAGE_KEY =
  "accessibility-dashboard.organization-create-attempt.v1";
export const ORGANIZATION_NAME_MAX_LENGTH = 100;

export type PersistedOrganizationCreateAttempt = {
  version: 2;
  attemptId: string;
  apiScope: string;
  name: string;
  startedAt: number;
  organizationId: number | null;
};

export type StoredOrganizationCreateAttempt = {
  attempt: PersistedOrganizationCreateAttempt;
  rawValue: string;
};

function isOrganizationName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= ORGANIZATION_NAME_MAX_LENGTH
  );
}

function normalizePersistedOrganizationCreateAttempt(
  value: unknown
): PersistedOrganizationCreateAttempt | null {
  if (
    !isObjectRecord(value) ||
    // Keep the storage key so pre-idempotency attempts are blocked, never replayed.
    value.version !== 2 ||
    !isUuid(value.attemptId) ||
    value.apiScope !== API_BASE_URL ||
    !isOrganizationName(value.name) ||
    !(value.organizationId === null || isPositiveSafeInteger(value.organizationId)) ||
    !isPositiveSafeInteger(value.startedAt)
  ) {
    return null;
  }

  return {
    version: 2,
    attemptId: value.attemptId,
    apiScope: API_BASE_URL,
    name: value.name.trim(),
    startedAt: value.startedAt as number,
    organizationId: value.organizationId as number | null
  };
}

export function readOrganizationCreateRecovery(): RecoveryRead<PersistedOrganizationCreateAttempt> {
  return readSessionRecovery(
    ORGANIZATION_CREATE_STORAGE_KEY,
    normalizePersistedOrganizationCreateAttempt
  );
}

export function isPersistedOrganizationCreateAttemptStale(
  attempt: PersistedOrganizationCreateAttempt,
  now = Date.now()
): boolean {
  return isRecoveryTimestampStale(attempt.startedAt, now);
}

export function writePersistedOrganizationCreateAttempt(
  attempt: PersistedOrganizationCreateAttempt,
  expectedRawValue: string | null
): StoredOrganizationCreateAttempt | null {
  const stored = writeSessionRecoveryIfUnchanged(
    ORGANIZATION_CREATE_STORAGE_KEY,
    attempt,
    normalizePersistedOrganizationCreateAttempt,
    expectedRawValue
  );
  if (stored === null) {
    return null;
  }
  return { attempt: stored.value, rawValue: stored.rawValue };
}

export function clearPersistedOrganizationCreateAttempt(
  expectedRawValue: string
): boolean {
  return clearSessionRecoveryIfUnchanged(
    ORGANIZATION_CREATE_STORAGE_KEY,
    expectedRawValue
  );
}

export function clearOrganizationCreateRecoveryStorage(): void {
  clearSessionRecoveryStorage(ORGANIZATION_CREATE_STORAGE_KEY);
}
