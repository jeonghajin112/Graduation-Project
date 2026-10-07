import {
  fetchAnalysisAttempt,
  fetchActiveTargetRequests,
  submitEvaluationTargetRescan
} from "@/services/analysis-protocol-api";
import { API_BASE_URL } from "@/config/api";
import {
  fetchEvaluationTarget,
  fetchEvaluationRequests,
} from "@/services/backend-api";
import {
  clearSiteCreateRecovery,
  clearTargetRescanRecovery,
  normalizeSiteCreateAccessUrl,
  readSiteCreateRecovery,
  readTargetRescanRecovery,
  writeSiteCreateRecovery,
  writeTargetRescanRecovery
} from "@/services/site-create-recovery-storage";
import type { PersistedSiteCreateAttempt, StoredSiteCreateAttempt } from "@/services/site-create-recovery-storage";
import { createRandomUuid } from "@/services/random-uuid";
import { UserFacingError } from "@/services/user-facing-error";
import { isPositiveSafeInteger } from "@/lib/guards";
import type {
  DashboardViewModel,
  EvaluationRequestModel
} from "@/types/accessibility-domain";

import { selectLatestEvaluationRequest } from "@/services/evaluation-request-selection";
import {
  REQUEST_RECONCILE_ATTEMPTS,
  REQUEST_RECONCILE_INTERVAL_MS,
  SITE_RECOVERY_BLOCKED_MESSAGE,
  SITE_RECOVERY_PERSISTENCE_MESSAGE,
  TARGET_ANALYSIS_PREFLIGHT_MESSAGE,
  TARGET_REQUEST_RECOVERY_MESSAGE,
  commitMutationOnce,
  getPersistedTargetId,
  isDefinitiveMutationRejection,
  reconcileWithRetries,
  runWithNetworkDeadline
} from "./site-create-recovery-workflow";
import type { DirectoryRecoveryToken, LoadDashboard } from "./use-dashboard-data";
import {
  persistAcceptedAnalysisRequest,
  recordAcceptedAnalysisRequest
} from "./analysis-request-acceptance";

export type TargetAnalysisRequestCheckpoint = {
  targetId: number;
  knownRequestIds: number[];
  requestId: number | null;
  releaseAbortListener: (() => void) | null;
  recoveryToken: DirectoryRecoveryToken | null;
  /** `null` once an accepted rescan needs no durable state. */
  stored: StoredSiteCreateAttempt | null;
};

export type UseEvaluationTargetAnalysisRequestOptions = {
  beginDirectoryRecovery: () => DirectoryRecoveryToken;
  dashboardData: DashboardViewModel | null;
  endDirectoryRecovery: (token: DirectoryRecoveryToken) => void;
  loadDashboard?: LoadDashboard;
};

export const ABANDONED_RESCAN_RECONCILE_ATTEMPTS = 4;
export const ABANDONED_RESCAN_RECONCILE_INTERVAL_MS = 1_000;

function isPreparedRescan(attempt: PersistedSiteCreateAttempt): boolean {
  // A rescan starts with an existing target. A partially completed page
  // creation excludes its new target from this baseline and must be preserved.
  return attempt.phase === "request-ready" &&
    attempt.previousTargetIds.includes(attempt.targetId);
}

function isTerminalRequest(request: EvaluationRequestModel): boolean {
  return request.status === "COMPLETED" || request.status === "FAILED";
}

/**
 * Where one analysis request keeps its durable checkpoint. The page-creation
 * flow continues in the single shared creation slot. A rescan of an existing
 * page uses a per-page slot, so a cancelled rescan on page A never blocks page
 * B, a new page creation, or another project.
 */
type RecoverySlot = {
  kind: "site-create" | "rescan";
  write: (
    attempt: PersistedSiteCreateAttempt,
    expectedRawValue: string | null
  ) => StoredSiteCreateAttempt | null;
  clear: (rawValue: string) => boolean;
};

const siteCreateSlot: RecoverySlot = {
  kind: "site-create",
  write: writeSiteCreateRecovery,
  clear: clearSiteCreateRecovery
};

function createRescanSlot(targetId: number): RecoverySlot {
  return {
    kind: "rescan",
    write: writeTargetRescanRecovery,
    clear: (rawValue) => clearTargetRescanRecovery(targetId, rawValue)
  };
}

type ReconcilingAttempt = Extract<PersistedSiteCreateAttempt, { phase: "request-reconciling" }>;

/**
 * Finds the request created by one submitted attempt. With a server receipt
 * key a foreground retry may resend the same idempotent POST; a background
 * cleanup only reads.
 */
async function probeSubmittedRequest(
  { analysisKey, knownRequestIds, targetId }: Pick<ReconcilingAttempt, "analysisKey" | "knownRequestIds" | "targetId">,
  signal: AbortSignal,
  allowIdempotentResubmit: boolean
): Promise<EvaluationRequestModel | null> {
  if (analysisKey) {
    const receipt = await fetchAnalysisAttempt(analysisKey, signal);
    if (receipt) return receipt.evaluationTargetId === targetId ? receipt : null;
    return allowIdempotentResubmit
      ? submitEvaluationTargetRescan(targetId, signal, analysisKey)
      : null;
  }
  const known = new Set(knownRequestIds);
  const reconciledRequests = await fetchEvaluationRequests(signal);
  const candidates = reconciledRequests.filter(
    (request) => request.evaluationTargetId === targetId && !known.has(request.id)
  );
  // Without a server correlation key, choosing among multiple
  // candidates could attach this modal to another actor's request.
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * A rescan cancelled after its POST (page closed, navigation) may still be
 * accepted by the server. Settle its per-page checkpoint with GETs only,
 * detached from the closed UI. An unreadable outcome keeps the checkpoint for
 * the next rescan of that page, and it stops blocking after 24 hours.
 */
export async function settleAbandonedTargetRescan(
  stored: StoredSiteCreateAttempt,
  onAccepted?: (request: EvaluationRequestModel) => void
): Promise<void> {
  const attempt = stored.attempt;
  if (attempt.phase !== "request-reconciling") {
    return;
  }
  let request: EvaluationRequestModel | null;
  try {
    request = await runWithNetworkDeadline((signal) => reconcileWithRetries({
      attempts: ABANDONED_RESCAN_RECONCILE_ATTEMPTS,
      intervalMs: ABANDONED_RESCAN_RECONCILE_INTERVAL_MS,
      signal,
      probe: (probeSignal) => probeSubmittedRequest(attempt, probeSignal, false)
    }));
  } catch {
    return;
  }
  // Found, or never arrived after a bounded wait: nothing from this tab is in
  // flight any more. A late server-side commit is still caught by the active
  // request preflight of the next rescan.
  clearTargetRescanRecovery(attempt.targetId, stored.rawValue);
  if (request) {
    onAccepted?.(request);
  }
}

type ReadyAttempt = Extract<PersistedSiteCreateAttempt, { phase: "request-ready" }>;

function createCheckpoint(
  targetId: number,
  knownRequestIds: number[],
  requestId: number | null,
  stored: StoredSiteCreateAttempt | null,
  recoveryToken: DirectoryRecoveryToken | null = null
): TargetAnalysisRequestCheckpoint {
  return { targetId, knownRequestIds, requestId, releaseAbortListener: null, recoveryToken, stored };
}

/**
 * Picks the slot this request continues in and the checkpoint stored there.
 * The shared creation slot is consulted only for the page it created.
 * Unrelated or unreadable creation work belongs to the page-add dialog.
 */
function openRecoverySlot(targetId: number): { slot: RecoverySlot; stored: StoredSiteCreateAttempt | null } {
  const siteCreateRecovery = readSiteCreateRecovery();
  if (siteCreateRecovery.kind === "valid") {
    if (isPreparedRescan(siteCreateRecovery.attempt)) {
      // Older clients wrote this before the first GET. No POST is pending
      // in request-ready, so release only that exact standalone preparation.
      if (!clearSiteCreateRecovery(siteCreateRecovery.rawValue)) {
        throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
    } else if (getPersistedTargetId(siteCreateRecovery.attempt) === targetId) {
      return {
        slot: siteCreateSlot,
        stored: { attempt: siteCreateRecovery.attempt, rawValue: siteCreateRecovery.rawValue }
      };
    }
  }

  const slot = createRescanSlot(targetId);
  const rescanRecovery = readTargetRescanRecovery(targetId);
  if (rescanRecovery.kind === "blocked") {
    // An unreadable value cannot describe a POST we could reconcile. When
    // storage itself is unavailable (rawValue null), the checkpoint write
    // fails closed before any POST.
    if (rescanRecovery.rawValue !== null && !slot.clear(rescanRecovery.rawValue)) {
      throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
    }
  } else if (rescanRecovery.kind === "valid") {
    if (!rescanRecovery.isStale && rescanRecovery.attempt.phase !== "poll") {
      return { slot, stored: { attempt: rescanRecovery.attempt, rawValue: rescanRecovery.rawValue } };
    }
    // A day-old checkpoint (or an accepted one whose retirement failed)
    // no longer protects anything the active-request preflight misses.
    if (!slot.clear(rescanRecovery.rawValue)) {
      throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
    }
  }
  return { slot, stored: null };
}

/** A fresh checkpoint for analysing an existing page of the loaded dashboard. */
function prepareRescanAttempt(
  dashboardData: DashboardViewModel | null,
  targetId: number,
  previousFailedRequestId: number | null
): ReadyAttempt {
  const project = dashboardData?.organizations.find((organization) =>
    organization.evaluationTargets.some((target) => target.id === targetId)
  );
  const target = project?.evaluationTargets.find((candidate) => candidate.id === targetId);
  if (!project || !target) {
    throw new UserFacingError(
      "등록된 페이지 정보를 확인하지 못했습니다. 목록을 새로 고친 뒤 다시 시도해 주세요."
    );
  }
  return {
    version: 1,
    attemptId: createRandomUuid(),
    apiScope: API_BASE_URL,
    projectId: project.id,
    name: target.name,
    accessUrl: normalizeSiteCreateAccessUrl(target.accessUrl),
    previousTargetIds: project.evaluationTargets.map((candidate) => candidate.id),
    startedAt: Date.now(),
    phase: "request-ready",
    targetId,
    previousFailedRequestId
  };
}

/** The page must still be the one the checkpoint describes before anything is sent. */
function assertTargetUnchanged(
  current: Awaited<ReturnType<typeof fetchEvaluationTarget>>,
  attempt: ReadyAttempt
): void {
  if (
    current.status !== "ACTIVE" ||
    current.organizationId !== attempt.projectId ||
    current.name !== attempt.name ||
    normalizeSiteCreateAccessUrl(current.accessUrl) !== normalizeSiteCreateAccessUrl(attempt.accessUrl)
  ) {
    throw new UserFacingError(TARGET_ANALYSIS_PREFLIGHT_MESSAGE);
  }
}

type RequestContext = UseEvaluationTargetAnalysisRequestOptions & {
  targetAnalysisRequestCheckpointRef: { current: TargetAnalysisRequestCheckpoint | null };
  releaseRequestCheckpoint: (checkpoint: TargetAnalysisRequestCheckpoint | null) => void;
  bindCheckpointToSignal: (checkpoint: TargetAnalysisRequestCheckpoint, signal?: AbortSignal) => void;
};

export async function requestTargetAnalysis(
  { beginDirectoryRecovery, dashboardData, endDirectoryRecovery, loadDashboard,
    targetAnalysisRequestCheckpointRef, releaseRequestCheckpoint, bindCheckpointToSignal }: RequestContext,
  targetId: number, signal?: AbortSignal, previousFailedRequestId?: number
): Promise<number> {
  signal?.throwIfAborted();
  const reconcileCheckpoint = async (
    stored: StoredSiteCreateAttempt
  ): Promise<EvaluationRequestModel | null> => {
    const attempt = stored.attempt;
    if (attempt.phase !== "request-reconciling") {
      return null;
    }
    return runWithNetworkDeadline(async (reconcileSignal) =>
      reconcileWithRetries({
        attempts: REQUEST_RECONCILE_ATTEMPTS,
        intervalMs: REQUEST_RECONCILE_INTERVAL_MS,
        signal: reconcileSignal,
        probe: (requestSignal) => probeSubmittedRequest(attempt, requestSignal, true)
      }), signal);
  };

  const replaceRequestId =
    previousFailedRequestId !== undefined && isPositiveSafeInteger(previousFailedRequestId)
      ? previousFailedRequestId
      : null;

  const { slot, stored: openedCheckpoint } = openRecoverySlot(targetId);
  let stored = openedCheckpoint;

  const acceptRequest = (
    checkpoint: TargetAnalysisRequestCheckpoint,
    input: Parameters<typeof recordAcceptedAnalysisRequest>[1]
  ): number => {
    if (slot.kind === "site-create") {
      return recordAcceptedAnalysisRequest(
        checkpoint as { stored: StoredSiteCreateAttempt; requestId: number | null },
        input
      );
    }
    // The dashboard poller owns an accepted rescan's progress; retire its
    // per-page checkpoint so nothing lingers after the page closes. A failed
    // retirement is reconciled (and replaced) by the next rescan.
    if (input.expectedRawValue !== null) {
      slot.clear(input.expectedRawValue);
    }
    checkpoint.stored = null;
    checkpoint.requestId = input.requestId;
    return input.requestId;
  };

  const abandonIfCancelled = (checkpoint: TargetAnalysisRequestCheckpoint) => {
    if (slot.kind !== "rescan" || !signal?.aborted || checkpoint.stored === null) {
      return;
    }
    void settleAbandonedTargetRescan(checkpoint.stored, () => {
      void loadDashboard?.({ background: true, refreshAfterInFlight: true });
    });
  };

  if (slot.kind === "site-create" && stored?.attempt.phase === "poll") {
    if (replaceRequestId === null) {
      releaseRequestCheckpoint(targetAnalysisRequestCheckpointRef.current);
      targetAnalysisRequestCheckpointRef.current =
        createCheckpoint(targetId, stored.attempt.knownRequestIds, stored.attempt.requestId, stored);
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

  if (stored?.attempt.phase === "request-reconciling") {
    const reconcilingStored: StoredSiteCreateAttempt = stored;
    const reconcilingAttempt = stored.attempt;
    let existingCheckpoint = targetAnalysisRequestCheckpointRef.current;
    if (
      existingCheckpoint === null ||
      existingCheckpoint.stored?.attempt.attemptId !== reconcilingAttempt.attemptId
    ) {
      releaseRequestCheckpoint(existingCheckpoint);
      existingCheckpoint = createCheckpoint(
        targetId, reconcilingAttempt.knownRequestIds, null, reconcilingStored, beginDirectoryRecovery()
      );
      targetAnalysisRequestCheckpointRef.current = existingCheckpoint;
    } else {
      existingCheckpoint.stored = reconcilingStored;
      existingCheckpoint.knownRequestIds = reconcilingAttempt.knownRequestIds;
      existingCheckpoint.requestId = null;
    }
    bindCheckpointToSignal(existingCheckpoint, signal);

    let recoveredRequest: EvaluationRequestModel | null;
    try {
      recoveredRequest = await reconcileCheckpoint(reconcilingStored);
    } catch (error) {
      abandonIfCancelled(existingCheckpoint);
      throw error;
    }
    if (recoveredRequest === null) {
      throw new UserFacingError(TARGET_REQUEST_RECOVERY_MESSAGE);
    }
    if (slot.kind === "rescan" && isTerminalRequest(recoveredRequest)) {
      // The earlier rescan already finished while its page was closed. This
      // click asks for a new analysis, so retire it and start fresh below.
      releaseRequestCheckpoint(existingCheckpoint);
      if (!slot.clear(reconcilingStored.rawValue)) {
        throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
      stored = null;
    } else {
      return acceptRequest(existingCheckpoint, {
        attempt: reconcilingAttempt,
        expectedRawValue: reconcilingStored.rawValue,
        targetId,
        knownRequestIds: reconcilingAttempt.knownRequestIds,
        requestId: recoveredRequest.id
      });
    }
  }

  const readyAttempt = stored === null
    ? prepareRescanAttempt(dashboardData, targetId, replaceRequestId)
    : stored.attempt;
  if (readyAttempt.phase !== "request-ready") {
    throw new UserFacingError(SITE_RECOVERY_BLOCKED_MESSAGE);
  }

  assertTargetUnchanged(
    await runWithNetworkDeadline(
      (requestSignal) => fetchEvaluationTarget(targetId, requestSignal),
      signal
    ),
    readyAttempt
  );

  const effectiveFailedRequestId =
    replaceRequestId ?? readyAttempt.previousFailedRequestId;

  releaseRequestCheckpoint(targetAnalysisRequestCheckpointRef.current);

  const knownRequestIds = new Set(
    (dashboardData?.analysisProtocolVersion === 1 ? [] : dashboardData?.evaluationRequests ?? [])
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
      (requestSignal) => dashboardData?.analysisProtocolVersion === 1
        ? fetchActiveTargetRequests(targetId, requestSignal) : fetchEvaluationRequests(requestSignal),
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
    if (slot.kind === "rescan") {
      endDirectoryRecovery(recoveryToken);
      if (stored !== null && !slot.clear(stored.rawValue)) {
        throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
      targetAnalysisRequestCheckpointRef.current =
        createCheckpoint(targetId, [...knownRequestIds], inFlightRequest.id, null);
      return inFlightRequest.id;
    }
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
    targetAnalysisRequestCheckpointRef.current =
      createCheckpoint(targetId, [...knownRequestIds], inFlightRequest.id, pollStored);
    return inFlightRequest.id;
  }

  const requestReconciling = slot.write(
    {
      ...readyAttempt,
      phase: "request-reconciling",
      analysisKey: dashboardData?.analysisProtocolVersion === 1 ? createRandomUuid() : undefined,
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
  const checkpoint = createCheckpoint(targetId, [...knownRequestIds], null, requestReconciling, recoveryToken);
  targetAnalysisRequestCheckpointRef.current = checkpoint;
  bindCheckpointToSignal(checkpoint, signal);
  const analysisKey = requestReconciling.attempt.analysisKey;

  try {
    try {
      const commitOutcome = await commitMutationOnce({
        signal,
        operation: async (requestSignal) =>
          (await submitEvaluationTargetRescan(targetId, requestSignal, analysisKey)).id,
        accept: (requestId) =>
          requestId !== null && !knownRequestIds.has(requestId) ? requestId : null
      });
      if (commitOutcome.kind === "accepted") {
        return acceptRequest(checkpoint, {
          attempt: requestReconciling.attempt,
          expectedRawValue: requestReconciling.rawValue,
          targetId,
          knownRequestIds: checkpoint.knownRequestIds,
          requestId: commitOutcome.value
        });
      }
    } catch (error) {
      if (isDefinitiveMutationRejection(error)) {
        if (readyAttempt.previousTargetIds.includes(targetId)) {
          const cleared = slot.clear(requestReconciling.rawValue);
          releaseRequestCheckpoint(checkpoint);
          if (!cleared) throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          throw error;
        }
        const requestReady = slot.write(
          {
            ...requestReconciling.attempt,
            phase: "request-ready",
            targetId,
            previousFailedRequestId: effectiveFailedRequestId
          },
          requestReconciling.rawValue
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
    const recoveredRequest = await reconcileCheckpoint(requestReconciling);
    if (recoveredRequest !== null) {
      return acceptRequest(checkpoint, {
        attempt: requestReconciling.attempt,
        expectedRawValue: requestReconciling.rawValue,
        targetId,
        knownRequestIds: checkpoint.knownRequestIds,
        requestId: recoveredRequest.id
      });
    }
  } catch (error) {
    abandonIfCancelled(checkpoint);
    throw error;
  }

  throw new UserFacingError(TARGET_REQUEST_RECOVERY_MESSAGE);
}
