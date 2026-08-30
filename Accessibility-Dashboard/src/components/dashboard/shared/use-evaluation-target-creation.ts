import { useCallback, useEffect, useRef } from "react";

import { API_BASE_URL } from "@/config/api";
import { wait } from "@/services/async-cancellation";
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
  getPersistedTargetId,
  isDefinitiveMutationRejection,
  runWithNetworkDeadline
} from "./site-create-recovery-workflow";
import type { DirectoryRecoveryToken, LoadDashboard } from "./use-dashboard-data";

type TargetCreateCheckpoint = {
  key: string;
  projectId: number;
  name: string;
  accessUrl: string;
  previousTargetIds: number[];
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
      if (checkpoint.recoveryToken !== null) {
        endDirectoryRecovery(checkpoint.recoveryToken);
      }
      targetCreateCheckpointRef.current = null;
    }
  }, [
    dashboardData?.evaluationRequests,
    dashboardData?.organizations,
    endDirectoryRecovery
  ]);

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

      const releaseTargetCheckpoint = (checkpoint: TargetCreateCheckpoint | null) => {
        if (checkpoint?.recoveryToken !== null && checkpoint?.recoveryToken !== undefined) {
          endDirectoryRecovery(checkpoint.recoveryToken);
        }
        if (targetCreateCheckpointRef.current === checkpoint) {
          targetCreateCheckpointRef.current = null;
        }
      };

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
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
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
          for (let attempt = 0; attempt < TARGET_CREATE_RECONCILE_ATTEMPTS; attempt += 1) {
            if (signal?.aborted) {
              throw new DOMException("The operation was aborted.", "AbortError");
            }
            if (reconcileController.signal.aborted) {
              return null;
            }
            if (attempt > 0) {
              await wait(TARGET_CREATE_RECONCILE_INTERVAL_MS, reconcileController.signal);
            }

            const refreshedTargets = await fetchEvaluationTargetsForOrganization(
              checkpoint.projectId,
              reconcileController.signal
            );
            const recoveredTargetId = findCheckpointTargetId(checkpoint, refreshedTargets);
            if (recoveredTargetId !== null) {
              // Best-effort UI refresh. Recovery correctness depends only on
              // the targeted list above, so an unrelated overview error
              // cannot cause another POST.
              await loadDashboard({
                refreshAfterInFlight: true,
                clearOnError: false,
                signal: reconcileController.signal
              });
              return recoveredTargetId;
            }
          }
          return null;
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
        throw new Error(SITE_RECOVERY_BLOCKED_MESSAGE);
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

          const recoveredTargetId = await reconcileCheckpoint(existingCheckpoint);
          if (recoveredTargetId !== null) {
            return finishTargetRecovery(existingCheckpoint, recoveredTargetId);
          }
          throw new Error(TARGET_CREATE_RECOVERY_MESSAGE);
        }

        throw new Error(SITE_RECOVERY_CONFLICT_MESSAGE);
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
        throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
      const checkpoint: TargetCreateCheckpoint = {
        key,
        projectId: normalizedInput.projectId,
        name: normalizedInput.name,
        accessUrl: normalizedInput.accessUrl,
        previousTargetIds,
        recoveryToken,
        resolvedTargetId: null,
        stored
      };
      targetCreateCheckpointRef.current = checkpoint;

      try {
        const createdTarget = await runWithNetworkDeadline(
          (requestSignal) => createEvaluationTargetModel(normalizedInput, requestSignal),
          signal
        );
        if (
          !Number.isSafeInteger(createdTarget?.id) ||
          createdTarget.id <= 0 ||
          previousTargetIds.includes(createdTarget.id) ||
          createdTarget.organizationId !== normalizedInput.projectId ||
          createdTarget.status !== "ACTIVE" ||
          createdTarget.name.trim() !== normalizedInput.name ||
          normalizeSiteCreateAccessUrl(createdTarget.accessUrl) !== normalizedInput.accessUrl
        ) {
          throw new Error(TARGET_CREATE_RECOVERY_MESSAGE);
        }
        return finishTargetRecovery(checkpoint, createdTarget.id);
      } catch (error) {
        if (isDefinitiveMutationRejection(error)) {
          const didClear = clearSiteCreateRecovery(checkpoint.stored.rawValue);
          releaseTargetCheckpoint(checkpoint);
          if (!didClear) {
            throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
          throw error;
        }

        // A timeout, connection reset, 5xx, or unusable success body can all
        // occur after the server committed the target. The durable checkpoint
        // was written before the POST, so every later retry is GET-only.
        targetCreateCheckpointRef.current = checkpoint;
        if (signal?.aborted) {
          throw error;
        }
      }

      const recoveredTargetId = await reconcileCheckpoint(checkpoint);
      if (recoveredTargetId !== null) {
        return finishTargetRecovery(checkpoint, recoveredTargetId);
      }
      throw new Error(TARGET_CREATE_RECOVERY_MESSAGE);
    },
    [beginDirectoryRecovery, endDirectoryRecovery, loadDashboard]
  );
}
