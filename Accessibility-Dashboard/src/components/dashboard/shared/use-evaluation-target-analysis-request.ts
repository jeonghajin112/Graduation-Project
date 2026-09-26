import { useCallback, useEffect, useRef } from "react";
import type { TargetAnalysisRequestCheckpoint, UseEvaluationTargetAnalysisRequestOptions } from "./target-analysis-request";

export function useEvaluationTargetAnalysisRequest({
  beginDirectoryRecovery,
  dashboardData,
  endDirectoryRecovery
}: UseEvaluationTargetAnalysisRequestOptions) {
  const targetAnalysisRequestCheckpointRef =
    useRef<TargetAnalysisRequestCheckpoint | null>(null);

  const releaseCheckpointLease = useCallback(
    (checkpoint: TargetAnalysisRequestCheckpoint | null) => {
      checkpoint?.releaseAbortListener?.();
      if (checkpoint) {
        checkpoint.releaseAbortListener = null;
      }
      if (checkpoint?.recoveryToken !== null && checkpoint?.recoveryToken !== undefined) {
        endDirectoryRecovery(checkpoint.recoveryToken);
        checkpoint.recoveryToken = null;
      }
    },
    [endDirectoryRecovery]
  );

  const releaseRequestCheckpoint = useCallback(
    (checkpoint: TargetAnalysisRequestCheckpoint | null) => {
      releaseCheckpointLease(checkpoint);
      if (targetAnalysisRequestCheckpointRef.current === checkpoint) {
        targetAnalysisRequestCheckpointRef.current = null;
      }
    },
    [releaseCheckpointLease]
  );

  const bindCheckpointToSignal = useCallback(
    (checkpoint: TargetAnalysisRequestCheckpoint, signal?: AbortSignal) => {
      checkpoint.releaseAbortListener?.();
      checkpoint.releaseAbortListener = null;
      if (!signal) {
        return;
      }

      const handleAbort = () => releaseRequestCheckpoint(checkpoint);
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
      checkpoint.releaseAbortListener = () => {
        signal.removeEventListener("abort", handleAbort);
      };
    },
    [releaseRequestCheckpoint]
  );

  useEffect(() => {
    const checkpoint = targetAnalysisRequestCheckpointRef.current;
    if (
      checkpoint?.requestId !== null &&
      checkpoint?.requestId !== undefined &&
      checkpoint.recoveryToken !== null &&
      dashboardData?.evaluationRequests.some(
        (request) => request.id === checkpoint.requestId
      )
    ) {
      releaseCheckpointLease(checkpoint);
    }
  }, [
    dashboardData?.evaluationRequests,
    dashboardData?.organizations,
    releaseCheckpointLease
  ]);

  useEffect(
    () => () => {
      releaseRequestCheckpoint(targetAnalysisRequestCheckpointRef.current);
    },
    [releaseRequestCheckpoint]
  );

  return useCallback(
    async (
      targetId: number,
      signal?: AbortSignal,
      previousFailedRequestId?: number
    ): Promise<number> => {
      const { requestTargetAnalysis } = await import("./target-analysis-request");
      return requestTargetAnalysis({
        beginDirectoryRecovery, dashboardData, endDirectoryRecovery,
        targetAnalysisRequestCheckpointRef, releaseRequestCheckpoint, bindCheckpointToSignal
      }, targetId, signal, previousFailedRequestId);
    },
    [
      beginDirectoryRecovery,
      bindCheckpointToSignal,
      dashboardData,
      endDirectoryRecovery,
      releaseRequestCheckpoint
    ]
  );
}
