import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE_URL } from "@/config/api";
import {
  clearTargetRescanAttempt,
  readTargetRescanRecovery,
  writeTargetRescanAttempt,
  type PersistedTargetRescanAttempt
} from "@/services/analysis-recovery-storage";
import { throwIfAborted, wait } from "@/services/async-cancellation";
import {
  ApiRequestError,
  getApiErrorMessage,
  isAbortError,
  requestEvaluationTargetRescan
} from "@/services/backend-api";
import type {
  DashboardViewModel,
  EvaluationRequestModel,
  EvaluationTargetModel,
  OrganizationModel
} from "@/types/accessibility-domain";

import { useCancellationScope } from "./use-cancellation-scope";
import type { LoadDashboard } from "./use-dashboard-data";

const RESCAN_RESULT_POLL_ATTEMPTS = 12;
const RESCAN_RESULT_POLL_INTERVAL_MS = 2000;
const RESCAN_REQUEST_TIMEOUT_MS = 15_000;

const DEFINITIVE_RESCAN_REJECTION_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 413, 414, 415, 416, 417, 418,
  421, 422, 423, 424, 426, 428, 431, 451
]);

type RescanCheckpointBase = {
  attemptId: string;
  startedAt: number;
  targetId: number;
  knownRequestIds: number[];
};

type RescanCheckpoint = RescanCheckpointBase & (
  | {
      kind: "reconciling";
    }
  | {
      kind: "known";
      requestId: number;
    }
);

const RESCAN_PERSISTENCE_FAILURE_MESSAGE =
  "브라우저에 다시 스캔 복구 정보를 안전하게 저장하지 못해 새 요청을 보내지 않았습니다.";
const RESCAN_BLOCKED_RECOVERY_MESSAGE =
  "확인할 수 없는 다시 스캔 복구 정보가 남아 있어 중복 요청을 막기 위해 새 요청을 차단했습니다. 로그아웃 후 다시 시도해 주세요.";

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isDefinitiveRescanRejection(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status !== null &&
    DEFINITIVE_RESCAN_REJECTION_STATUSES.has(error.status)
  );
}

async function runRescanRequestWithTimeout<T>({
  operation,
  signal,
  timeoutMessage
}: {
  operation: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal;
  timeoutMessage: string;
}): Promise<T> {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RESCAN_REQUEST_TIMEOUT_MS);

  try {
    const result = await operation(controller.signal);
    if (timedOut && !signal.aborted) {
      throw new Error(timeoutMessage);
    }
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (timedOut && !signal.aborted) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener("abort", forwardAbort);
  }
}

function findCheckpointRequest(
  data: DashboardViewModel,
  checkpoint: RescanCheckpoint
): EvaluationRequestModel | null {
  if (checkpoint.kind === "known") {
    return data.evaluationRequests.find((request) => request.id === checkpoint.requestId) ?? null;
  }

  const knownRequestIds = new Set(checkpoint.knownRequestIds);
  const candidates = data.evaluationRequests.filter(
    (request) =>
      request.evaluationTargetId === checkpoint.targetId &&
      !knownRequestIds.has(request.id)
  );
  // No frontend-only signal can distinguish our committed request from another
  // actor's concurrent request. Match exactly one candidate or fail closed.
  return candidates.length === 1 ? candidates[0]! : null;
}

function checkpointFromPersistedTargetRescanAttempt(
  attempt: PersistedTargetRescanAttempt
): RescanCheckpoint {
  const common = {
    attemptId: attempt.attemptId,
    startedAt: attempt.startedAt,
    targetId: attempt.targetId,
    knownRequestIds: attempt.knownRequestIds
  };
  return attempt.phase === "known"
    ? { ...common, kind: "known", requestId: attempt.requestId }
    : { ...common, kind: "reconciling" };
}

function persistedAttemptFromRescanCheckpoint(
  checkpoint: RescanCheckpoint
): PersistedTargetRescanAttempt {
  const common = {
    attemptId: checkpoint.attemptId,
    apiScope: API_BASE_URL,
    startedAt: checkpoint.startedAt,
    targetId: checkpoint.targetId,
    knownRequestIds: checkpoint.knownRequestIds
  };
  return checkpoint.kind === "known"
    ? { ...common, phase: "known", requestId: checkpoint.requestId }
    : { ...common, phase: "reconciling" };
}

function isFinalRequestStatus(status: string) {
  return status === "COMPLETED" || status === "FAILED";
}

export function useEvaluationTargetRescan({
  dashboardData,
  loadDashboard,
  onError,
  selectedEvaluationTargetModel,
  selectedOrganizationModel
}: {
  dashboardData: DashboardViewModel | null;
  loadDashboard: LoadDashboard;
  onError: (message: string) => void;
  selectedEvaluationTargetModel: EvaluationTargetModel | null;
  selectedOrganizationModel: OrganizationModel | null;
}) {
  const initialRecoveryRef = useRef<ReturnType<typeof readTargetRescanRecovery> | null>(null);
  if (initialRecoveryRef.current === null) {
    initialRecoveryRef.current = readTargetRescanRecovery();
  }
  const initialRecovery = initialRecoveryRef.current;
  const restoredAttempts = initialRecovery.kind === "valid" ? initialRecovery.value : [];
  const [isRescanningSite, setIsRescanningSite] = useState(false);
  const { beginScope, cancelScope } = useCancellationScope();
  const submissionLockRef = useRef(false);
  const isMountedRef = useRef(false);
  const activeOperationIdRef = useRef<symbol | null>(null);
  const currentSelectedTargetIdRef = useRef<number | null>(
    selectedEvaluationTargetModel?.id ?? null
  );
  const checkpointByTargetIdRef = useRef(
    new Map<number, RescanCheckpoint>(
      restoredAttempts.map((attempt) => [
        attempt.targetId,
        checkpointFromPersistedTargetRescanAttempt(attempt)
      ])
    )
  );
  const recoveryBlockedRef = useRef(initialRecovery.kind === "blocked");
  const selectedOrganizationId = selectedOrganizationModel?.id ?? null;
  const selectedTargetId = selectedEvaluationTargetModel?.id ?? null;
  currentSelectedTargetIdRef.current = selectedTargetId;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeOperationIdRef.current = null;
      submissionLockRef.current = false;
    };
  }, []);

  useEffect(() => {
    // The controller survives dashboard route changes. Cancel the old target's
    // request explicitly so a hanging POST cannot lock the newly selected page.
    cancelScope();
    activeOperationIdRef.current = null;
    submissionLockRef.current = false;
    setIsRescanningSite(false);
  }, [cancelScope, selectedOrganizationId, selectedTargetId]);

  const handleRescanEvaluationTargetModel = useCallback(async () => {
    if (
      submissionLockRef.current ||
      !selectedOrganizationModel ||
      !selectedEvaluationTargetModel
    ) {
      return;
    }

    if (recoveryBlockedRef.current) {
      onError(RESCAN_BLOCKED_RECOVERY_MESSAGE);
      return;
    }

    const targetId = selectedEvaluationTargetModel.id;
    submissionLockRef.current = true;
    const operationId = Symbol("evaluation-target-rescan-operation");
    activeOperationIdRef.current = operationId;
    const signal = beginScope();
    const isActiveOperation = () =>
      isMountedRef.current &&
      activeOperationIdRef.current === operationId &&
      currentSelectedTargetIdRef.current === targetId;
    setIsRescanningSite(true);
    onError("");

    try {
      let checkpoint = checkpointByTargetIdRef.current.get(targetId) ?? null;
      if (checkpoint === null) {
        // Mutation refreshes replace a stalled background poll instead of
        // inheriting it. The fresh list is also the ownership baseline used if
        // the POST response is lost after commit.
        const baseline = await runRescanRequestWithTimeout({
          signal,
          timeoutMessage: "다시 스캔 전 기존 요청 목록을 확인하는 시간이 초과되었습니다.",
          operation: (requestSignal) =>
            loadDashboard({
              refreshAfterInFlight: true,
              clearOnError: false,
              signal: requestSignal
            })
        });
        if (!isActiveOperation()) {
          return;
        }
        if (baseline === null) {
          throw new Error("다시 스캔 전 기존 요청 목록을 불러오지 못했습니다.");
        }

        const attemptId = window.crypto.randomUUID();
        const startedAt = Date.now();
        const knownRequestIds = baseline.evaluationRequests
          .filter((request) => request.evaluationTargetId === targetId)
          .map((request) => request.id);
        const postingAttempt: PersistedTargetRescanAttempt = {
          attemptId,
          apiScope: API_BASE_URL,
          startedAt,
          targetId,
          knownRequestIds,
          phase: "posting"
        };
        if (!writeTargetRescanAttempt(postingAttempt, null)) {
          throw new Error(RESCAN_PERSISTENCE_FAILURE_MESSAGE);
        }

        const reconcilingCheckpoint: Extract<RescanCheckpoint, { kind: "reconciling" }> = {
          kind: "reconciling",
          attemptId,
          startedAt,
          targetId,
          knownRequestIds
        };
        checkpointByTargetIdRef.current.set(targetId, reconcilingCheckpoint);
        checkpoint = reconcilingCheckpoint;

        try {
          const createdRequestId = await runRescanRequestWithTimeout({
            signal,
            timeoutMessage: "다시 스캔 요청 응답을 기다리는 시간이 초과되었습니다.",
            operation: (requestSignal) =>
              requestEvaluationTargetRescan(targetId, requestSignal)
          });
          if (!isActiveOperation()) {
            return;
          }
          if (isPositiveSafeInteger(createdRequestId)) {
            const knownCheckpoint: Extract<RescanCheckpoint, { kind: "known" }> = {
              ...reconcilingCheckpoint,
              kind: "known",
              requestId: createdRequestId
            };
            if (
              !writeTargetRescanAttempt(
                persistedAttemptFromRescanCheckpoint(knownCheckpoint),
                attemptId
              )
            ) {
              throw new Error(RESCAN_PERSISTENCE_FAILURE_MESSAGE);
            }
            checkpointByTargetIdRef.current.set(targetId, knownCheckpoint);
            checkpoint = knownCheckpoint;
          }
        } catch (error) {
          if (isDefinitiveRescanRejection(error)) {
            if (!clearTargetRescanAttempt(targetId, attemptId)) {
              throw new Error(RESCAN_PERSISTENCE_FAILURE_MESSAGE);
            }
            checkpointByTargetIdRef.current.delete(targetId);
            throw error;
          }
          if (!isActiveOperation()) {
            return;
          }
          // A timeout, network error, 5xx, or missing response ID is
          // indeterminate. Continue with GET-only reconciliation.
        }
        if (checkpoint.kind === "reconciling") {
          if (
            !writeTargetRescanAttempt(
              persistedAttemptFromRescanCheckpoint(checkpoint),
              checkpoint.attemptId
            )
          ) {
            throw new Error(RESCAN_PERSISTENCE_FAILURE_MESSAGE);
          }
        }
      }

      let reachedFinalRequest = false;
      for (let attempt = 0; attempt < RESCAN_RESULT_POLL_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          await wait(RESCAN_RESULT_POLL_INTERVAL_MS, signal);
        }

        const refreshedData = await runRescanRequestWithTimeout({
          signal,
          timeoutMessage: "다시 스캔 상태를 확인하는 시간이 초과되었습니다.",
          operation: (requestSignal) =>
            loadDashboard({
              refreshAfterInFlight: true,
              clearOnError: false,
              signal: requestSignal
            })
        });
        if (!isActiveOperation()) {
          return;
        }
        if (refreshedData === null) {
          continue;
        }

        const checkpointRequest = findCheckpointRequest(refreshedData, checkpoint);
        if (checkpointRequest === null) {
          continue;
        }
        if (checkpoint.kind === "reconciling") {
          const knownCheckpoint: Extract<RescanCheckpoint, { kind: "known" }> = {
            ...checkpoint,
            kind: "known",
            requestId: checkpointRequest.id
          };
          if (
            !writeTargetRescanAttempt(
              persistedAttemptFromRescanCheckpoint(knownCheckpoint),
              checkpoint.attemptId
            )
          ) {
            throw new Error(RESCAN_PERSISTENCE_FAILURE_MESSAGE);
          }
          checkpointByTargetIdRef.current.set(targetId, knownCheckpoint);
          checkpoint = knownCheckpoint;
        }

        if (isFinalRequestStatus(checkpointRequest.status)) {
          if (!clearTargetRescanAttempt(targetId, checkpoint.attemptId)) {
            throw new Error(RESCAN_PERSISTENCE_FAILURE_MESSAGE);
          }
          checkpointByTargetIdRef.current.delete(targetId);
          reachedFinalRequest = true;
          break;
        }
      }

      if (!reachedFinalRequest) {
        throw new Error(
          "다시 스캔 요청의 처리 결과를 아직 확인하지 못했습니다. 잠시 후 다시 시도해 주세요. 새 요청은 보내지 않습니다."
        );
      }
    } catch (error) {
      if (!isActiveOperation() || isAbortError(error)) {
        return;
      }

      onError(getApiErrorMessage(error, "다시 스캔 요청 중 오류가 발생했습니다."));
    } finally {
      if (activeOperationIdRef.current === operationId) {
        activeOperationIdRef.current = null;
        submissionLockRef.current = false;
        if (isMountedRef.current) {
          setIsRescanningSite(false);
        }
      }
    }
  }, [
    beginScope,
    dashboardData,
    loadDashboard,
    onError,
    selectedEvaluationTargetModel,
    selectedOrganizationModel
  ]);

  return {
    handleRescanEvaluationTargetModel,
    isRescanningSite
  };
}
