import { createRequestDeadline } from "@/services/async-cancellation";
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
import { createRandomUuid } from "@/services/random-uuid";
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

export type TargetCreateCheckpoint = {
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

export type UseEvaluationTargetCreationOptions = {
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

type CreationContext = Omit<UseEvaluationTargetCreationOptions, "dashboardData"> & {
  targetCreateCheckpointRef: { current: TargetCreateCheckpoint | null };
  releaseTargetCheckpoint: (checkpoint: TargetCreateCheckpoint | null) => void;
  bindTargetCheckpointToSignal: (checkpoint: TargetCreateCheckpoint, signal?: AbortSignal) => void;
};

function finishTargetRecovery(
  releaseTargetCheckpoint: CreationContext["releaseTargetCheckpoint"],
  checkpoint: TargetCreateCheckpoint,
  targetId: number
): number {
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
}

async function reconcileTargetCheckpoint(
  loadDashboard: LoadDashboard,
  checkpoint: TargetCreateCheckpoint,
  signal: AbortSignal | undefined
): Promise<number | null> {
  const deadline = createRequestDeadline({ signal, timeoutMs: TARGET_CREATE_TIMEOUT_MS });

  try {
    return await reconcileWithRetries({
      attempts: TARGET_CREATE_RECONCILE_ATTEMPTS,
      intervalMs: TARGET_CREATE_RECONCILE_INTERVAL_MS,
      signal: deadline.signal,
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
    if (deadline.signal.aborted && !signal?.aborted) {
      return null;
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

function adoptPersistedCheckpoint(
  { beginDirectoryRecovery, targetCreateCheckpointRef, releaseTargetCheckpoint }: CreationContext,
  key: string,
  stored: StoredSiteCreateAttempt
): TargetCreateCheckpoint {
  const existingCheckpoint = targetCreateCheckpointRef.current;
  if (
    existingCheckpoint !== null &&
    existingCheckpoint.stored.attempt.attemptId === stored.attempt.attemptId
  ) {
    existingCheckpoint.stored = stored;
    return existingCheckpoint;
  }
  releaseTargetCheckpoint(existingCheckpoint);
  const checkpoint: TargetCreateCheckpoint = {
    key,
    projectId: stored.attempt.projectId,
    name: stored.attempt.name,
    accessUrl: stored.attempt.accessUrl,
    previousTargetIds: stored.attempt.previousTargetIds,
    releaseAbortListener: null,
    recoveryToken: beginDirectoryRecovery(),
    resolvedTargetId: null,
    stored
  };
  targetCreateCheckpointRef.current = checkpoint;
  return checkpoint;
}

/** Continues the persisted creation of this same page with GETs only. */
async function resumeTargetCreation(
  context: CreationContext,
  key: string,
  stored: StoredSiteCreateAttempt,
  signal: AbortSignal | undefined
): Promise<number> {
  const { loadDashboard, releaseTargetCheckpoint, bindTargetCheckpointToSignal } = context;
  const persistedTargetId = getPersistedTargetId(stored.attempt);
  if (persistedTargetId !== null) {
    return persistedTargetId;
  }

  const checkpoint = adoptPersistedCheckpoint(context, key, stored);
  bindTargetCheckpointToSignal(checkpoint, signal);

  const recoveredTargetId = await reconcileTargetCheckpoint(loadDashboard, checkpoint, signal);
  if (recoveredTargetId !== null) {
    return finishTargetRecovery(releaseTargetCheckpoint, checkpoint, recoveredTargetId);
  }
  throw new UserFacingError(TARGET_CREATE_RECOVERY_MESSAGE);
}

/** Records a new creation attempt against the project's current page list. */
async function openTargetCheckpoint(
  { beginDirectoryRecovery, endDirectoryRecovery,
    targetCreateCheckpointRef, releaseTargetCheckpoint, bindTargetCheckpointToSignal }: CreationContext,
  key: string,
  normalizedInput: CreateEvaluationTargetModelInput,
  signal: AbortSignal | undefined
): Promise<TargetCreateCheckpoint> {
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
      attemptId: createRandomUuid(),
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
  return checkpoint;
}

/** A definitive rejection clears the checkpoint so a retry starts clean. */
function releaseRejectedCreation(
  releaseTargetCheckpoint: CreationContext["releaseTargetCheckpoint"],
  checkpoint: TargetCreateCheckpoint
): void {
  const didClear = clearSiteCreateRecovery(checkpoint.stored.rawValue);
  releaseTargetCheckpoint(checkpoint);
  if (!didClear) {
    throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
  }
}

export async function createTargetWithRecovery(
  context: CreationContext,
  input: CreateEvaluationTargetModelInput, signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted();
  const { loadDashboard, releaseTargetCheckpoint } = context;
  const normalizedInput = {
    projectId: input.projectId,
    name: input.name.trim(),
    accessUrl: normalizeSiteCreateAccessUrl(input.accessUrl)
  };
  const key = buildTargetCreateKey(normalizedInput);

  const persistedRecovery = readSiteCreateRecovery();
  if (persistedRecovery.kind === "blocked") {
    throw new UserFacingError(SITE_RECOVERY_BLOCKED_MESSAGE);
  }

  if (persistedRecovery.kind === "valid") {
    const persistedKey = buildPersistedTargetCreateKey(persistedRecovery.attempt);
    if (persistedKey === key) {
      return resumeTargetCreation(context, key, {
        attempt: persistedRecovery.attempt,
        rawValue: persistedRecovery.rawValue
      }, signal);
    }

    throw new UserFacingError(SITE_RECOVERY_CONFLICT_MESSAGE);
  }

  const checkpoint = await openTargetCheckpoint(context, key, normalizedInput, signal);

  try {
    const commitOutcome = await commitMutationOnce({
      signal,
      timeoutMs: TARGET_CREATE_TIMEOUT_MS,
      operation: (requestSignal) =>
        createEvaluationTargetModel(normalizedInput, requestSignal),
      // The response parser already matched the project, name, URL and status
      // to this input; only a pre-existing ID can still mean "not ours".
      accept: (createdTarget) =>
        checkpoint.previousTargetIds.includes(createdTarget.id) ? null : createdTarget.id
    });
    if (commitOutcome.kind === "accepted") {
      return finishTargetRecovery(releaseTargetCheckpoint, checkpoint, commitOutcome.value);
    }
  } catch (error) {
    if (isDefinitiveMutationRejection(error)) {
      releaseRejectedCreation(releaseTargetCheckpoint, checkpoint);
    }

    throw error;
  }

  // Timeout, connection reset, 5xx, and unusable success bodies are all
  // ambiguous. The durable checkpoint keeps every later retry GET-only.
  const recoveredTargetId = await reconcileTargetCheckpoint(loadDashboard, checkpoint, signal);
  if (recoveredTargetId !== null) {
    return finishTargetRecovery(releaseTargetCheckpoint, checkpoint, recoveredTargetId);
  }
  throw new UserFacingError(TARGET_CREATE_RECOVERY_MESSAGE);
}
