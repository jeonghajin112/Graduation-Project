import { useCallback, useEffect, useRef } from "react";
import type { CreateEvaluationTargetInput as CreateEvaluationTargetModelInput } from "@/types/accessibility-domain";
import type { TargetCreateCheckpoint, UseEvaluationTargetCreationOptions } from "./target-creation";

export function useEvaluationTargetCreation({
  beginDirectoryRecovery,
  dashboardData,
  endDirectoryRecovery,
  loadDashboard
}: UseEvaluationTargetCreationOptions) {
  const targetCreateCheckpointRef = useRef<TargetCreateCheckpoint | null>(null);

  const releaseTargetCheckpoint = useCallback(
    (checkpoint: TargetCreateCheckpoint | null) => {
      checkpoint?.releaseAbortListener?.();
      if (checkpoint) {
        checkpoint.releaseAbortListener = null;
      }
      if (checkpoint?.recoveryToken !== null && checkpoint?.recoveryToken !== undefined) {
        endDirectoryRecovery(checkpoint.recoveryToken);
        checkpoint.recoveryToken = null;
      }
      if (targetCreateCheckpointRef.current === checkpoint) {
        targetCreateCheckpointRef.current = null;
      }
    },
    [endDirectoryRecovery]
  );

  const bindTargetCheckpointToSignal = useCallback(
    (checkpoint: TargetCreateCheckpoint, signal?: AbortSignal) => {
      checkpoint.releaseAbortListener?.();
      checkpoint.releaseAbortListener = null;
      if (!signal) {
        return;
      }

      const handleAbort = () => releaseTargetCheckpoint(checkpoint);
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
      checkpoint.releaseAbortListener = () => {
        signal.removeEventListener("abort", handleAbort);
      };
    },
    [releaseTargetCheckpoint]
  );

  useEffect(() => {
    const checkpoint = targetCreateCheckpointRef.current;
    if (
      checkpoint?.resolvedTargetId !== null &&
      checkpoint?.resolvedTargetId !== undefined &&
      dashboardData?.organizations.some((organization) =>
        organization.evaluationTargets.some(
          (target) => target.id === checkpoint.resolvedTargetId
        )
      )
    ) {
      releaseTargetCheckpoint(checkpoint);
    }
  }, [
    dashboardData?.evaluationRequests,
    dashboardData?.organizations,
    releaseTargetCheckpoint
  ]);

  useEffect(
    () => () => releaseTargetCheckpoint(targetCreateCheckpointRef.current),
    [releaseTargetCheckpoint]
  );

  return useCallback(
    async (
      input: CreateEvaluationTargetModelInput,
      signal?: AbortSignal
    ): Promise<number> => {
      const { createTargetWithRecovery } = await import("./target-creation");
      return createTargetWithRecovery({
        beginDirectoryRecovery, endDirectoryRecovery, loadDashboard,
        targetCreateCheckpointRef, releaseTargetCheckpoint, bindTargetCheckpointToSignal
      }, input, signal);
    },
    [
      beginDirectoryRecovery,
      bindTargetCheckpointToSignal,
      endDirectoryRecovery,
      loadDashboard,
      releaseTargetCheckpoint
    ]
  );
}
