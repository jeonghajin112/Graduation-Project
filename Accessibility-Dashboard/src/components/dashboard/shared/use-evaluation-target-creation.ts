import { useCallback, useEffect, useRef } from "react";

import { API_BASE_URL } from "@/config/api";
import {
  createEvaluationTargetModel,
  fetchEvaluationTargetsForOrganization
} from "@/services/backend-api";
import {
  clearSiteCreateRecovery,
  normalizeSiteCreateAccessUrl,
  readSiteCreateRecovery,
  writeSiteCreateRecovery
} from "@/services/site-create-recovery-storage";
import type {
  PersistedSiteCreateAttempt,
  StoredSiteCreateAttempt
} from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  CreateEvaluationTargetInput as CreateEvaluationTargetModelInput,
  DashboardViewModel,
  EvaluationTarget
} from "@/types/accessibility-domain";

import {
  SITE_RECOVERY_BLOCKED_MESSAGE,
  SITE_RECOVERY_CONFLICT_MESSAGE,
  SITE_RECOVERY_PERSISTENCE_MESSAGE,
  TARGET_CREATE_RECONCILE_ATTEMPTS,
  TARGET_CREATE_RECONCILE_INTERVAL_MS,
  TARGET_CREATE_RECOVERY_MESSAGE,
  TARGET_CREATE_TIMEOUT_MS,
  commitMutationOnce,
  getPersistedTargetId,
  isDefinitiveMutationRejection,
  reconcileWithRetries,
  runWithNetworkDeadline
} from "./site-create-recovery-workflow";
import type { DirectoryRecoveryToken, LoadDashboard } from "./use-dashboard-data";

type TargetCreateCheckpoint = {
  key: string;
  projectId: number;
  name: string;
  accessUrl: string;
  previousTargetIds: number[];
  releaseAbortListener: (() => void) | null;
  recoveryToken: DirectoryRecoveryToken | null;
  resolvedTargetId: number | null;
  stored: StoredSiteCreateAttempt;
};

type UseEvaluationTargetCreationOptions = {
  beginDirectoryRecovery: () => DirectoryRecoveryToken;
  dashboardData: DashboardViewModel | null;
  endDirectoryRecovery: (token: DirectoryRecoveryToken) => void;
  loadDashboard: LoadDashboard;
};

function buildTargetCreateKey({
  projectId,
  name,
  accessUrl
}: CreateEvaluationTargetModelInput): string {
  return `${projectId}\u0000${name.trim()}\u0000${normalizeSiteCreateAccessUrl(accessUrl)}`;
}

function findCheckpointTargetId(
  checkpoint: TargetCreateCheckpoint,
  targets: EvaluationTarget[]
): number | null {
  const previousIds = new Set(checkpoint.previousTargetIds);
  const matchesCheckpoint = (target: EvaluationTarget) =>
    target.organizationId === checkpoint.projectId &&
    target.status === "ACTIVE" &&
    target.name.trim() === checkpoint.name &&
    normalizeSiteCreateAccessUrl(target.accessUrl) === checkpoint.accessUrl;
  const candidates = targets.filter(
    (target) => !previousIds.has(target.id) && matchesCheckpoint(target)
  );
  if (checkpoint.resolvedTargetId !== null) {
    return targets.some(
      (target) =>
        target.id === checkpoint.resolvedTargetId && matchesCheckpoint(target)
    )
      ? checkpoint.resolvedTargetId
      : null;
  }
  return candidates.length === 1 ? candidates[0]!.id : null;
}

function buildPersistedTargetCreateKey(attempt: PersistedSiteCreateAttempt): string {
  return buildTargetCreateKey({
    projectId: attempt.projectId,
    name: attempt.name,
    accessUrl: attempt.accessUrl
  });
}

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
      const normalizedInput = {
        projectId: input.projectId,
        name: input.name.trim(),
        accessUrl: normalizeSiteCreateAccessUrl(input.accessUrl)
      };
      const key = buildTargetCreateKey(normalizedInput);

      const finishTargetRecovery = (
        checkpoint: TargetCreateCheckpoint,
        targetId: number
      ): number => {
        const nextStored = writeSiteCreateRecovery(
          {
            ...checkpoint.stored.attempt,
            phase: "request-ready",
            targetId,
            previousFailedRequestId: null
          },
          checkpoint.stored.rawValue
        );
        if (nextStored === null) {
          throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        checkpoint.stored = nextStored;
        checkpoint.resolvedTargetId = targetId;
        releaseTargetCheckpoint(checkpoint);
        return targetId;
      };

      const reconcileCheckpoint = async (
        checkpoint: TargetCreateCheckpoint
      ): Promise<number | null> => {
        const reconcileController = new AbortController();
        const forwardCallerAbort = () => reconcileController.abort();
        if (signal?.aborted) {
          reconcileController.abort();
        } else {
          signal?.addEventListener("abort", forwardCallerAbort, { once: true });
        }
        const timeoutId = window.setTimeout(
          () => reconcileController.abort(),
          TARGET_CREATE_TIMEOUT_MS
        );

        try {
          return await reconcileWithRetries({
            attempts: TARGET_CREATE_RECONCILE_ATTEMPTS,
            intervalMs: TARGET_CREATE_RECONCILE_INTERVAL_MS,
            signal: reconcileController.signal,
            probe: async (reconcileSignal) => {
              const refreshedTargets = await fetchEvaluationTargetsForOrganization(
                checkpoint.projectId,
                reconcileSignal
              );
              const recoveredTargetId = findCheckpointTargetId(checkpoint, refreshedTargets);
              if (recoveredTargetId === null) {
                return null;
              }
              // Best-effort UI refresh. Recovery correctness depends only on
              // the targeted list above, so an unrelated overview error
              // cannot cause another POST.
              await loadDashboard({
                refreshAfterInFlight: true,
                clearOnError: false,
                signal: reconcileSignal
              });
              return recoveredTargetId;
            }
          });
        } catch (error) {
          if (reconcileController.signal.aborted && !signal?.aborted) {
            return null;
          }
          throw error;
        } finally {
          window.clearTimeout(timeoutId);
          signal?.removeEventListener("abort", forwardCallerAbort);
        }
      };

      const persistedRecovery = readSiteCreateRecovery();
      if (persistedRecovery.kind === "blocked") {
        throw new UserFacingError(SITE_RECOVERY_BLOCKED_MESSAGE);
      }

      if (persistedRecovery.kind === "valid") {
        const persistedKey = buildPersistedTargetCreateKey(persistedRecovery.attempt);
        if (persistedKey === key) {
          const persistedTargetId = getPersistedTargetId(persistedRecovery.attempt);
          if (persistedTargetId !== null) {
            return persistedTargetId;
          }

          let existingCheckpoint = targetCreateCheckpointRef.current;
          if (
            existingCheckpoint === null ||
            existingCheckpoint.stored.attempt.attemptId !==
              persistedRecovery.attempt.attemptId
          ) {
            releaseTargetCheckpoint(existingCheckpoint);
            existingCheckpoint = {
              key,
              projectId: persistedRecovery.attempt.projectId,
              name: persistedRecovery.attempt.name,
              accessUrl: persistedRecovery.attempt.accessUrl,
              previousTargetIds: persistedRecovery.attempt.previousTargetIds,
              releaseAbortListener: null,
              recoveryToken: beginDirectoryRecovery(),
              resolvedTargetId: null,
              stored: {
                attempt: persistedRecovery.attempt,
                rawValue: persistedRecovery.rawValue
              }
            };
            targetCreateCheckpointRef.current = existingCheckpoint;
          } else {
            existingCheckpoint.stored = {
              attempt: persistedRecovery.attempt,
              rawValue: persistedRecovery.rawValue
            };
          }
          bindTargetCheckpointToSignal(existingCheckpoint, signal);

          const recoveredTargetId = await reconcileCheckpoint(existingCheckpoint);
          if (recoveredTargetId !== null) {
            return finishTargetRecovery(existingCheckpoint, recoveredTargetId);
          }
          throw new UserFacingError(TARGET_CREATE_RECOVERY_MESSAGE);
        }

        throw new UserFacingError(SITE_RECOVERY_CONFLICT_MESSAGE);
      }

      const existingCheckpoint = targetCreateCheckpointRef.current;
      if (existingCheckpoint !== null) {
        releaseTargetCheckpoint(existingCheckpoint);
      }

      const recoveryToken = beginDirectoryRecovery();
      let previousTargetIds: number[];
      try {
        const baselineTargets = await runWithNetworkDeadline(
          (requestSignal) =>
            fetchEvaluationTargetsForOrganization(
              normalizedInput.projectId,
              requestSignal
            ),
          signal
        );
        previousTargetIds = baselineTargets.map((target) => target.id);
      } catch (error) {
        endDirectoryRecovery(recoveryToken);
        throw error;
      }
      const stored = writeSiteCreateRecovery(
        {
          version: 1,
          attemptId: window.crypto.randomUUID(),
          apiScope: API_BASE_URL,
          projectId: normalizedInput.projectId,
          name: normalizedInput.name,
          accessUrl: normalizedInput.accessUrl,
          previousTargetIds,
          startedAt: Date.now(),
          phase: "target-reconciling"
        },
        null
      );
      if (stored === null) {
        endDirectoryRecovery(recoveryToken);
        throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
      const checkpoint: TargetCreateCheckpoint = {
        key,
        projectId: normalizedInput.projectId,
        name: normalizedInput.name,
        accessUrl: normalizedInput.accessUrl,
        previousTargetIds,
        releaseAbortListener: null,
        recoveryToken,
        resolvedTargetId: null,
        stored
      };
      targetCreateCheckpointRef.current = checkpoint;
      bindTargetCheckpointToSignal(checkpoint, signal);

      try {
        const commitOutcome = await commitMutationOnce({
          signal,
          timeoutMs: TARGET_CREATE_TIMEOUT_MS,
          operation: (requestSignal) =>
            createEvaluationTargetModel(normalizedInput, requestSignal),
          accept: (createdTarget) =>
            Number.isSafeInteger(createdTarget?.id) &&
            createdTarget.id > 0 &&
            !previousTargetIds.includes(createdTarget.id) &&
            createdTarget.organizationId === normalizedInput.projectId &&
            createdTarget.status === "ACTIVE" &&
            createdTarget.name.trim() === normalizedInput.name &&
            normalizeSiteCreateAccessUrl(createdTarget.accessUrl) === normalizedInput.accessUrl
              ? createdTarget.id
              : null
        });
        if (commitOutcome.kind === "accepted") {
          return finishTargetRecovery(checkpoint, commitOutcome.value);
        }
      } catch (error) {
        if (isDefinitiveMutationRejection(error)) {
          const didClear = clearSiteCreateRecovery(checkpoint.stored.rawValue);
          releaseTargetCheckpoint(checkpoint);
          if (!didClear) {
            throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
          throw error;
        }

        throw error;
      }

      // Timeout, connection reset, 5xx, and unusable success bodies are all
      // ambiguous. The durable checkpoint keeps every later retry GET-only.
      const recoveredTargetId = await reconcileCheckpoint(checkpoint);
      if (recoveredTargetId !== null) {
        return finishTargetRecovery(checkpoint, recoveredTargetId);
      }
      throw new UserFacingError(TARGET_CREATE_RECOVERY_MESSAGE);
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
