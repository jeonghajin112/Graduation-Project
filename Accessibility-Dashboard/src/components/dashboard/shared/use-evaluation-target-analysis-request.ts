import { useCallback, useEffect, useRef } from "react";

import { API_BASE_URL } from "@/config/api";
import {
  fetchEvaluationTarget,
  fetchEvaluationRequests,
  requestEvaluationTargetRescan
} from "@/services/backend-api";
import {
  clearSiteCreateRecovery,
  normalizeSiteCreateAccessUrl,
  readSiteCreateRecovery,
  writeSiteCreateRecovery
} from "@/services/site-create-recovery-storage";
import type { PersistedSiteCreateAttempt, StoredSiteCreateAttempt } from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  DashboardViewModel,
  EvaluationRequestModel
} from "@/types/accessibility-domain";

import { selectLatestEvaluationRequest } from "@/services/evaluation-request-selection";
import {
  REQUEST_RECONCILE_ATTEMPTS,
  REQUEST_RECONCILE_INTERVAL_MS,
  SITE_RECOVERY_BLOCKED_MESSAGE,
  SITE_RECOVERY_CONFLICT_MESSAGE,
  SITE_RECOVERY_PERSISTENCE_MESSAGE,
  TARGET_ANALYSIS_PREFLIGHT_MESSAGE,
  TARGET_CREATE_RECOVERY_MESSAGE,
  TARGET_REQUEST_RECOVERY_MESSAGE,
  commitMutationOnce,
  getPersistedTargetId,
  isDefinitiveMutationRejection,
  reconcileWithRetries,
  runWithNetworkDeadline
} from "./site-create-recovery-workflow";
import type { DirectoryRecoveryToken } from "./use-dashboard-data";
import {
  persistAcceptedAnalysisRequest,
  recordAcceptedAnalysisRequest
} from "./analysis-request-acceptance";

type TargetAnalysisRequestCheckpoint = {
  targetId: number;
  knownRequestIds: number[];
  requestId: number | null;
  releaseAbortListener: (() => void) | null;
  recoveryToken: DirectoryRecoveryToken | null;
  stored: StoredSiteCreateAttempt;
};

type UseEvaluationTargetAnalysisRequestOptions = {
  beginDirectoryRecovery: () => DirectoryRecoveryToken;
  dashboardData: DashboardViewModel | null;
  endDirectoryRecovery: (token: DirectoryRecoveryToken) => void;
};

function isPreparedRescan(attempt: PersistedSiteCreateAttempt): boolean {
  // A rescan starts with an existing target. A partially completed page
  // creation excludes its new target from this baseline and must be preserved.
  return attempt.phase === "request-ready" &&
    attempt.previousTargetIds.includes(attempt.targetId);
}

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
      const reconcileCheckpoint = async (
        checkpoint: TargetAnalysisRequestCheckpoint
      ): Promise<number | null> =>
        runWithNetworkDeadline(async (reconcileSignal) => {
          const knownRequestIds = new Set(checkpoint.knownRequestIds);
          return reconcileWithRetries({
            attempts: REQUEST_RECONCILE_ATTEMPTS,
            intervalMs: REQUEST_RECONCILE_INTERVAL_MS,
            signal: reconcileSignal,
            probe: async (requestSignal) => {
              const reconciledRequests = await fetchEvaluationRequests(requestSignal);
              const candidates = reconciledRequests.filter(
                (request) =>
                  request.evaluationTargetId === checkpoint.targetId &&
                  !knownRequestIds.has(request.id)
              );
              // Without a server correlation key, choosing among multiple
              // candidates could attach this modal to another actor's request.
              return candidates.length === 1 ? candidates[0]!.id : null;
            }
          });
        }, signal);

      const replaceRequestId =
        Number.isSafeInteger(previousFailedRequestId) && (previousFailedRequestId ?? 0) > 0
          ? previousFailedRequestId ?? null
          : null;
      const persistedRecovery = readSiteCreateRecovery();
      if (persistedRecovery.kind === "blocked") {
        throw new UserFacingError(SITE_RECOVERY_BLOCKED_MESSAGE);
      }

      let stored: StoredSiteCreateAttempt | null = null;
      if (persistedRecovery.kind === "valid") {
        const persistedTargetId = getPersistedTargetId(persistedRecovery.attempt);
        if (isPreparedRescan(persistedRecovery.attempt)) {
          // Older clients wrote this before the first GET. No POST is pending
          // in request-ready, so release only that exact standalone preparation.
          if (!clearSiteCreateRecovery(persistedRecovery.rawValue)) {
            throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
        } else if (persistedTargetId === targetId) {
          stored = {
            attempt: persistedRecovery.attempt,
            rawValue: persistedRecovery.rawValue
          };
        } else {
          throw new UserFacingError(SITE_RECOVERY_CONFLICT_MESSAGE);
        }
      }

      if (stored?.attempt.phase === "target-reconciling") {
        throw new UserFacingError(TARGET_CREATE_RECOVERY_MESSAGE);
      }

      if (stored?.attempt.phase === "poll") {
        if (replaceRequestId === null) {
          releaseRequestCheckpoint(targetAnalysisRequestCheckpointRef.current);
          targetAnalysisRequestCheckpointRef.current = {
            targetId,
            knownRequestIds: stored.attempt.knownRequestIds,
            requestId: stored.attempt.requestId,
            releaseAbortListener: null,
            recoveryToken: null,
            stored
          };
          return stored.attempt.requestId;
        }
        if (replaceRequestId !== stored.attempt.requestId) {
          throw new UserFacingError(TARGET_REQUEST_RECOVERY_MESSAGE);
        }
        const requestReady = writeSiteCreateRecovery(
          {
            ...stored.attempt,
            phase: "request-ready",
            targetId,
            previousFailedRequestId: replaceRequestId
          },
          stored.rawValue
        );
        if (requestReady === null) {
          throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        stored = requestReady;
      }

      let preparedAttempt: Extract<PersistedSiteCreateAttempt, { phase: "request-ready" }> | null = null;
      if (stored === null) {
        const project = dashboardData?.organizations.find((organization) =>
          organization.evaluationTargets.some((target) => target.id === targetId)
        );
        const target = project?.evaluationTargets.find(
          (candidate) => candidate.id === targetId
        );
        if (!project || !target) {
          throw new UserFacingError(
            "등록된 페이지 정보를 확인하지 못했습니다. 목록을 새로 고친 뒤 다시 시도해 주세요."
          );
        }
        preparedAttempt = {
          version: 1,
          attemptId: window.crypto.randomUUID(),
          apiScope: API_BASE_URL,
          projectId: project.id,
          name: target.name,
          accessUrl: normalizeSiteCreateAccessUrl(target.accessUrl),
          previousTargetIds: project.evaluationTargets.map((candidate) => candidate.id),
          startedAt: Date.now(),
          phase: "request-ready",
          targetId,
          previousFailedRequestId: replaceRequestId
        };
      }

      if (stored?.attempt.phase === "request-reconciling") {
        let existingCheckpoint = targetAnalysisRequestCheckpointRef.current;
        if (
          existingCheckpoint === null ||
          existingCheckpoint.stored.attempt.attemptId !== stored.attempt.attemptId
        ) {
          releaseRequestCheckpoint(existingCheckpoint);
          existingCheckpoint = {
            targetId,
            knownRequestIds: stored.attempt.knownRequestIds,
            requestId: null,
            releaseAbortListener: null,
            recoveryToken: beginDirectoryRecovery(),
            stored
          };
          targetAnalysisRequestCheckpointRef.current = existingCheckpoint;
        } else {
          existingCheckpoint.stored = stored;
          existingCheckpoint.knownRequestIds = stored.attempt.knownRequestIds;
          existingCheckpoint.requestId = null;
        }
        bindCheckpointToSignal(existingCheckpoint, signal);

        const recoveredRequestId = await reconcileCheckpoint(existingCheckpoint);
        if (recoveredRequestId === null) {
          throw new UserFacingError(TARGET_REQUEST_RECOVERY_MESSAGE);
        }
        return recordAcceptedAnalysisRequest(existingCheckpoint, {
          attempt: stored.attempt,
          expectedRawValue: stored.rawValue,
          targetId,
          knownRequestIds: stored.attempt.knownRequestIds,
          requestId: recoveredRequestId
        });
      }

      const readyAttempt = stored?.attempt ?? preparedAttempt;
      if (readyAttempt?.phase !== "request-ready") {
        throw new UserFacingError(SITE_RECOVERY_BLOCKED_MESSAGE);
      }

      const currentTarget = await runWithNetworkDeadline(
        (requestSignal) => fetchEvaluationTarget(targetId, requestSignal),
        signal
      );
      if (
        currentTarget.status !== "ACTIVE" ||
        currentTarget.organizationId !== readyAttempt.projectId ||
        currentTarget.name !== readyAttempt.name ||
        normalizeSiteCreateAccessUrl(currentTarget.accessUrl) !==
          normalizeSiteCreateAccessUrl(readyAttempt.accessUrl)
      ) {
        throw new UserFacingError(TARGET_ANALYSIS_PREFLIGHT_MESSAGE);
      }

      const effectiveFailedRequestId =
        replaceRequestId ?? readyAttempt.previousFailedRequestId;

      releaseRequestCheckpoint(targetAnalysisRequestCheckpointRef.current);

      const knownRequestIds = new Set(
        (dashboardData?.evaluationRequests ?? [])
          .filter((request) => request.evaluationTargetId === targetId)
          .map((request) => request.id)
      );
      if (effectiveFailedRequestId !== null) {
        knownRequestIds.add(effectiveFailedRequestId);
      }

      // Protect the visible snapshot while the targeted request-list preflight
      // decides whether a POST is needed.
      const recoveryToken = beginDirectoryRecovery();
      let beforeRequests: EvaluationRequestModel[];
      try {
        beforeRequests = await runWithNetworkDeadline(
          (requestSignal) => fetchEvaluationRequests(requestSignal),
          signal
        );
        signal?.throwIfAborted();
      } catch (error) {
        endDirectoryRecovery(recoveryToken);
        throw error;
      }
      for (const request of beforeRequests) {
        if (request.evaluationTargetId === targetId) {
          knownRequestIds.add(request.id);
        }
      }

      const inFlightRequest = selectLatestEvaluationRequest(
        beforeRequests.filter(
          (request) =>
            request.evaluationTargetId === targetId &&
            request.status !== "COMPLETED" &&
            request.status !== "FAILED"
        ) ?? []
      );
      if (inFlightRequest) {
        let pollStored;
        try {
          pollStored = persistAcceptedAnalysisRequest({
            attempt: readyAttempt,
            expectedRawValue: stored?.rawValue ?? null,
            targetId,
            knownRequestIds: [...knownRequestIds],
            requestId: inFlightRequest.id
          });
        } finally {
          endDirectoryRecovery(recoveryToken);
        }
        targetAnalysisRequestCheckpointRef.current = {
          targetId,
          knownRequestIds: [...knownRequestIds],
          requestId: inFlightRequest.id,
          releaseAbortListener: null,
          recoveryToken: null,
          stored: pollStored
        };
        return inFlightRequest.id;
      }

      const requestReconciling = writeSiteCreateRecovery(
        {
          ...readyAttempt,
          phase: "request-reconciling",
          targetId,
          knownRequestIds: [...knownRequestIds],
          previousFailedRequestId: effectiveFailedRequestId
        },
        stored?.rawValue ?? null
      );
      if (requestReconciling === null) {
        endDirectoryRecovery(recoveryToken);
        throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
      const checkpoint: TargetAnalysisRequestCheckpoint = {
        targetId,
        knownRequestIds: [...knownRequestIds],
        requestId: null,
        releaseAbortListener: null,
        recoveryToken,
        stored: requestReconciling
      };
      targetAnalysisRequestCheckpointRef.current = checkpoint;
      bindCheckpointToSignal(checkpoint, signal);

      try {
        const commitOutcome = await commitMutationOnce({
          signal,
          operation: (requestSignal) =>
            requestEvaluationTargetRescan(targetId, requestSignal),
          accept: (requestId) =>
            requestId !== null && !knownRequestIds.has(requestId) ? requestId : null
        });
        if (commitOutcome.kind === "accepted") {
          return recordAcceptedAnalysisRequest(checkpoint, {
            attempt: checkpoint.stored.attempt,
            expectedRawValue: checkpoint.stored.rawValue,
            targetId,
            knownRequestIds: checkpoint.knownRequestIds,
            requestId: commitOutcome.value
          });
        }
      } catch (error) {
        if (isDefinitiveMutationRejection(error)) {
          if (readyAttempt.previousTargetIds.includes(targetId)) {
            const cleared = clearSiteCreateRecovery(checkpoint.stored.rawValue);
            releaseRequestCheckpoint(checkpoint);
            if (!cleared) throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
            throw error;
          }
          const requestReady = writeSiteCreateRecovery(
            {
              ...checkpoint.stored.attempt,
              phase: "request-ready",
              targetId,
              previousFailedRequestId: effectiveFailedRequestId
            },
            checkpoint.stored.rawValue
          );
          releaseRequestCheckpoint(checkpoint);
          if (requestReady === null) {
            throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
          throw error;
        }
        throw error;
      }

      // A lost POST response does not prove that the server rejected the
      // request. Reconcile the request list before allowing a retry so the UI
      // does not start a duplicate scan for the same target.
      const recoveredRequestId = await reconcileCheckpoint(checkpoint);
      if (recoveredRequestId !== null) {
        return recordAcceptedAnalysisRequest(checkpoint, {
          attempt: checkpoint.stored.attempt,
          expectedRawValue: checkpoint.stored.rawValue,
          targetId,
          knownRequestIds: checkpoint.knownRequestIds,
          requestId: recoveredRequestId
        });
      }

      throw new UserFacingError(TARGET_REQUEST_RECOVERY_MESSAGE);
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
