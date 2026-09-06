import { fetchDashboardViewModel } from "@/services/backend-api";
import { UserFacingError } from "@/services/user-facing-error";
import type { DashboardViewModel } from "@/types/accessibility-domain";

import { commitMutationOnce, runMutationRequestWithDeadline } from "./mutation-recovery";

export const DIRECTORY_STATUS_TIMEOUT_MS = 5_000;
export const DIRECTORY_STATUS_ERROR =
  "현재 처리 상태를 확인하지 못했습니다. 창을 닫아도 됩니다. 다시 시도하면 먼저 처리 상태를 확인합니다.";
export const DIRECTORY_RESULT_UNKNOWN_ERROR =
  "요청 처리 결과를 확인하지 못했습니다. 서버에서 처리 중일 수 있습니다. 창을 닫아도 되며, 다시 시도하면 먼저 처리 상태를 확인합니다.";

/** A user action sends at most one PATCH. Recovery only reads fresh server state. */
export async function runDirectoryMutation({
  operation,
  isApplied,
  signal
}: {
  operation: (signal: AbortSignal) => Promise<void>;
  isApplied: (snapshot: DashboardViewModel) => boolean;
  signal: AbortSignal;
}): Promise<void> {
  const checkApplied = async () => {
    try {
      const snapshot = await runMutationRequestWithDeadline({
        operation: fetchDashboardViewModel,
        signal,
        timeoutMs: DIRECTORY_STATUS_TIMEOUT_MS
      });
      return isApplied(snapshot);
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
