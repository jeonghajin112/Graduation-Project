import { useCallback, useEffect, useRef } from "react";

import { API_BASE_URL } from "@/config/api";
import { wait } from "@/services/async-cancellation";
import {
  fetchEvaluationTarget,
  fetchEvaluationRequests,
  requestEvaluationTargetRescan
} from "@/services/backend-api";
import {
  normalizeSiteCreateAccessUrl,
  readSiteCreateRecovery,
  writeSiteCreateRecovery
} from "@/services/site-create-recovery-storage";
import type { StoredSiteCreateAttempt } from "@/services/site-create-recovery-storage";
import type {
  DashboardViewModel,
  EvaluationRequestModel
} from "@/types/accessibility-domain";

import { selectLatestEvaluationRequest } from "./evaluation-request-selection";
import {
  REQUEST_RECONCILE_ATTEMPTS,
  REQUEST_RECONCILE_INTERVAL_MS,
  SITE_RECOVERY_BLOCKED_MESSAGE,
  SITE_RECOVERY_CONFLICT_MESSAGE,
  SITE_RECOVERY_PERSISTENCE_MESSAGE,
  TARGET_ANALYSIS_PREFLIGHT_MESSAGE,
  TARGET_CREATE_RECOVERY_MESSAGE,
  TARGET_REQUEST_RECOVERY_MESSAGE,
  getPersistedTargetId,
  isDefinitiveMutationRejection,
  runWithNetworkDeadline
} from "./site-create-recovery-workflow";
import type { DirectoryRecoveryToken } from "./use-dashboard-data";

type TargetAnalysisRequestCheckpoint = {
  targetId: number;
  knownRequestIds: number[];
  requestId: number | null;
  recoveryToken: DirectoryRecoveryToken | null;
  stored: StoredSiteCreateAttempt;
};

type UseEvaluationTargetAnalysisRequestOptions = {
  beginDirectoryRecovery: () => DirectoryRecoveryToken;
  dashboardData: DashboardViewModel | null;
  endDirectoryRecovery: (token: DirectoryRecoveryToken) => void;
};

export function useEvaluationTargetAnalysisRequest({
  beginDirectoryRecovery,
  dashboardData,
  endDirectoryRecovery
}: UseEvaluationTargetAnalysisRequestOptions) {
  const targetAnalysisRequestCheckpointRef =
    useRef<TargetAnalysisRequestCheckpoint | null>(null);

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
      endDirectoryRecovery(checkpoint.recoveryToken);
      checkpoint.recoveryToken = null;
    }
  }, [
    dashboardData?.evaluationRequests,
    dashboardData?.organizations,
    endDirectoryRecovery
  ]);

  return useCallback(
    async (
      targetId: number,
      signal?: AbortSignal,
      previousFailedRequestId?: number
    ): Promise<number> => {
      const releaseRequestCheckpoint = (
        checkpoint: TargetAnalysisRequestCheckpoint | null
      ) => {
        if (checkpoint?.recoveryToken !== null && checkpoint?.recoveryToken !== undefined) {
          endDirectoryRecovery(checkpoint.recoveryToken);
        }
        if (targetAnalysisRequestCheckpointRef.current === checkpoint) {
          targetAnalysisRequestCheckpointRef.current = null;
        }
      };

      const reconcileCheckpoint = async (
        checkpoint: TargetAnalysisRequestCheckpoint
      ): Promise<number | null> =>
        runWithNetworkDeadline(async (reconcileSignal) => {
          const knownRequestIds = new Set(checkpoint.knownRequestIds);
          for (let attempt = 0; attempt < REQUEST_RECONCILE_ATTEMPTS; attempt += 1) {
            if (attempt > 0) {
              await wait(REQUEST_RECONCILE_INTERVAL_MS, reconcileSignal);
            }

            const reconciledRequests = await fetchEvaluationRequests(reconcileSignal);
            const candidates = reconciledRequests.filter(
              (request) =>
                request.evaluationTargetId === checkpoint.targetId &&
                !knownRequestIds.has(request.id)
            );
            if (candidates.length === 1) {
              return candidates[0]!.id;
            }
            if (candidates.length > 1) {
              // Without a server correlation key, choosing either candidate
              // could attach this modal to another actor's request.
              return null;
            }
          }
          return null;
        }, signal);

      const replaceRequestId =
        Number.isSafeInteger(previousFailedRequestId) && (previousFailedRequestId ?? 0) > 0
          ? previousFailedRequestId ?? null
          : null;
      const persistedRecovery = readSiteCreateRecovery();
      if (persistedRecovery.kind === "blocked") {
        throw new Error(SITE_RECOVERY_BLOCKED_MESSAGE);
      }

      let stored: StoredSiteCreateAttempt | null = null;
      if (persistedRecovery.kind === "valid") {
        const persistedTargetId = getPersistedTargetId(persistedRecovery.attempt);
        if (persistedTargetId === targetId) {
          stored = {
            attempt: persistedRecovery.attempt,
            rawValue: persistedRecovery.rawValue
          };
        } else {
          throw new Error(SITE_RECOVERY_CONFLICT_MESSAGE);
        }
      }

      if (stored?.attempt.phase === "target-reconciling") {
        throw new Error(TARGET_CREATE_RECOVERY_MESSAGE);
      }

      if (stored?.attempt.phase === "poll") {
        if (replaceRequestId === null) {
          targetAnalysisRequestCheckpointRef.current = {
            targetId,
            knownRequestIds: stored.attempt.knownRequestIds,
            requestId: stored.attempt.requestId,
            recoveryToken: null,
            stored
          };
          return stored.attempt.requestId;
        }
        if (replaceRequestId !== stored.attempt.requestId) {
          throw new Error(TARGET_REQUEST_RECOVERY_MESSAGE);
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
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        stored = requestReady;
      }

      if (stored === null) {
        const project = dashboardData?.organizations.find((organization) =>
          organization.evaluationTargets.some((target) => target.id === targetId)
        );
        const target = project?.evaluationTargets.find(
          (candidate) => candidate.id === targetId
        );
        if (!project || !target) {
          throw new Error(
            "등록된 페이지 정보를 확인하지 못했습니다. 목록을 새로 고친 뒤 다시 시도해 주세요."
          );
        }
        stored = writeSiteCreateRecovery(
          {
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
          },
          null
        );
        if (stored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
      }

      if (stored.attempt.phase === "request-reconciling") {
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
            recoveryToken: beginDirectoryRecovery(),
            stored
          };
          targetAnalysisRequestCheckpointRef.current = existingCheckpoint;
        } else {
          existingCheckpoint.stored = stored;
          existingCheckpoint.knownRequestIds = stored.attempt.knownRequestIds;
          existingCheckpoint.requestId = null;
        }

        const recoveredRequestId = await reconcileCheckpoint(existingCheckpoint);
        if (recoveredRequestId === null) {
          throw new Error(TARGET_REQUEST_RECOVERY_MESSAGE);
        }
        const pollStored = writeSiteCreateRecovery(
          {
            ...stored.attempt,
            phase: "poll",
            targetId,
            knownRequestIds: stored.attempt.knownRequestIds,
            requestId: recoveredRequestId
          },
          stored.rawValue
        );
        if (pollStored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        existingCheckpoint.stored = pollStored;
        existingCheckpoint.requestId = recoveredRequestId;
        if (existingCheckpoint.recoveryToken !== null) {
          endDirectoryRecovery(existingCheckpoint.recoveryToken);
          existingCheckpoint.recoveryToken = null;
        }
        return recoveredRequestId;
      }

      if (stored.attempt.phase !== "request-ready") {
        throw new Error(SITE_RECOVERY_BLOCKED_MESSAGE);
      }

      const currentTarget = await runWithNetworkDeadline(
        (requestSignal) => fetchEvaluationTarget(targetId, requestSignal),
        signal
      );
      if (
        currentTarget.status !== "ACTIVE" ||
        currentTarget.organizationId !== stored.attempt.projectId ||
        currentTarget.name !== stored.attempt.name ||
        normalizeSiteCreateAccessUrl(currentTarget.accessUrl) !==
          normalizeSiteCreateAccessUrl(stored.attempt.accessUrl)
      ) {
        throw new Error(TARGET_ANALYSIS_PREFLIGHT_MESSAGE);
      }

      const effectiveFailedRequestId =
        replaceRequestId ?? stored.attempt.previousFailedRequestId;
      if (
        replaceRequestId !== null &&
        stored.attempt.previousFailedRequestId !== replaceRequestId
      ) {
        const updatedReady = writeSiteCreateRecovery(
          {
            ...stored.attempt,
            phase: "request-ready",
            targetId,
            previousFailedRequestId: replaceRequestId
          },
          stored.rawValue
        );
        if (updatedReady === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        stored = updatedReady;
      }

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
        const pollStored = writeSiteCreateRecovery(
          {
            ...stored.attempt,
            phase: "poll",
            targetId,
            knownRequestIds: [...knownRequestIds],
            requestId: inFlightRequest.id
          },
          stored.rawValue
        );
        endDirectoryRecovery(recoveryToken);
        if (pollStored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        targetAnalysisRequestCheckpointRef.current = {
          targetId,
          knownRequestIds: [...knownRequestIds],
          requestId: inFlightRequest.id,
          recoveryToken: null,
          stored: pollStored
        };
        return inFlightRequest.id;
      }

      const requestReconciling = writeSiteCreateRecovery(
        {
          ...stored.attempt,
          phase: "request-reconciling",
          targetId,
          knownRequestIds: [...knownRequestIds],
          previousFailedRequestId: effectiveFailedRequestId
        },
        stored.rawValue
      );
      if (requestReconciling === null) {
        endDirectoryRecovery(recoveryToken);
        throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
      const checkpoint: TargetAnalysisRequestCheckpoint = {
        targetId,
        knownRequestIds: [...knownRequestIds],
        requestId: null,
        recoveryToken,
        stored: requestReconciling
      };
      targetAnalysisRequestCheckpointRef.current = checkpoint;

      try {
        const requestId = await runWithNetworkDeadline(
          (requestSignal) => requestEvaluationTargetRescan(targetId, requestSignal),
          signal
        );
        if (requestId !== null && !knownRequestIds.has(requestId)) {
          const pollStored = writeSiteCreateRecovery(
            {
              ...checkpoint.stored.attempt,
              phase: "poll",
              targetId,
              knownRequestIds: checkpoint.knownRequestIds,
              requestId
            },
            checkpoint.stored.rawValue
          );
          if (pollStored === null) {
            throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
          checkpoint.stored = pollStored;
          checkpoint.requestId = requestId;
          return requestId;
        }
      } catch (error) {
        if (isDefinitiveMutationRejection(error)) {
          const requestReady = writeSiteCreateRecovery(
            {
              ...checkpoint.stored.attempt,
              phase: "request-ready",
              targetId,
              previousFailedRequestId: effectiveFailedRequestId
            },
            checkpoint.stored.rawValue
          );
          if (checkpoint.recoveryToken !== null) {
            endDirectoryRecovery(checkpoint.recoveryToken);
          }
          targetAnalysisRequestCheckpointRef.current = null;
          if (requestReady === null) {
            throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
          throw error;
        }
        if (signal?.aborted) {
          throw error;
        }
      }

      // A lost POST response does not prove that the server rejected the
      // request. Reconcile the request list before allowing a retry so the UI
      // does not start a duplicate scan for the same target.
      const recoveredRequestId = await reconcileCheckpoint(checkpoint);
      if (recoveredRequestId !== null) {
        const pollStored = writeSiteCreateRecovery(
          {
            ...checkpoint.stored.attempt,
            phase: "poll",
            targetId,
            knownRequestIds: checkpoint.knownRequestIds,
            requestId: recoveredRequestId
          },
          checkpoint.stored.rawValue
        );
        if (pollStored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        checkpoint.stored = pollStored;
        checkpoint.requestId = recoveredRequestId;
        if (checkpoint.recoveryToken !== null) {
          endDirectoryRecovery(checkpoint.recoveryToken);
          checkpoint.recoveryToken = null;
        }
        return recoveredRequestId;
      }

      throw new Error(TARGET_REQUEST_RECOVERY_MESSAGE);
    },
    [beginDirectoryRecovery, dashboardData, endDirectoryRecovery]
  );
}
