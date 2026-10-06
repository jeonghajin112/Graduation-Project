import { fetchEvaluationTargetState, fetchOrganizationState } from "@/services/backend-api";
import { UserFacingError } from "@/services/user-facing-error";

import { commitMutationOnce, runMutationRequestWithDeadline } from "./mutation-recovery";

export const DIRECTORY_STATUS_TIMEOUT_MS = 5_000;
export const DIRECTORY_STATUS_ERROR =
  "현재 처리 상태를 확인하지 못했습니다. 창을 닫아도 됩니다. 다시 시도하면 먼저 처리 상태를 확인합니다.";
export const DIRECTORY_RESULT_UNKNOWN_ERROR =
  "요청 처리 결과를 확인하지 못했습니다. 서버에서 처리 중일 수 있습니다. 창을 닫아도 되며, 다시 시도하면 먼저 처리 상태를 확인합니다.";

/**
 * A user action sends at most one PATCH. Recovery only reads fresh server
 * state of the single project or page being changed: the full dashboard
 * overview can be slow on large data sets, and one unrelated malformed record
 * there must not block every rename or deletion.
 */
export async function runDirectoryMutation({
  operation,
  readApplied,
  signal
}: {
  operation: (signal: AbortSignal) => Promise<void>;
  readApplied: (signal: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
}): Promise<void> {
  const checkApplied = async () => {
    try {
      return await runMutationRequestWithDeadline({
        operation: readApplied,
        signal,
        timeoutMs: DIRECTORY_STATUS_TIMEOUT_MS
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UserFacingError(DIRECTORY_STATUS_ERROR);
    }
  };

  // Also runs after closing/reopening the modal or reloading the app. A late
  // successful request must not be blindly repeated from an old UI snapshot.
  if (await checkApplied()) return;

  const outcome = await commitMutationOnce({ operation, accept: () => true, signal });
  if (outcome.kind === "accepted") return;

  try {
    if (await checkApplied()) return;
  } catch (error) {
    if (signal.aborted) throw error;
  }
  throw new UserFacingError(DIRECTORY_RESULT_UNKNOWN_ERROR);
}

export function readOrganizationUpdateApplied({
  projectId,
  name,
  description
}: {
  projectId: number;
  name: string;
  description: string;
}) {
  return async (signal: AbortSignal): Promise<boolean> => {
    const organization = await fetchOrganizationState(projectId, signal);
    return organization !== null &&
      organization.name === name &&
      (organization.description ?? "") === description;
  };
}

export function readOrganizationRemoved(projectId: number) {
  return async (signal: AbortSignal): Promise<boolean> => {
    const organization = await fetchOrganizationState(projectId, signal);
    return organization === null || organization.status === "INACTIVE";
  };
}

export function readEvaluationTargetRemoved(siteId: number) {
  return async (signal: AbortSignal): Promise<boolean> => {
    const target = await fetchEvaluationTargetState(siteId, signal);
    return target === null || target.status !== "ACTIVE";
  };
}
