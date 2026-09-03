import { ArrowRight, Check, Loader2, Search, X } from "lucide-react";
import { useRef, useState } from "react";

import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  StepperTrigger
} from "@/components/ui/stepper";
import { API_BASE_URL } from "@/config/api";
import {
  fetchDashboardViewModel,
  fetchEvaluationRequest,
  fetchEvaluationTarget,
  getApiErrorMessage,
  isAbortError,
  startUrlEvaluation
} from "@/services/backend-api";
import {
  clearQuickAnalysisAttempt,
  readQuickAnalysisRecovery,
  writeQuickAnalysisAttempt,
  type PersistedQuickAnalysisAttempt
} from "@/services/analysis-recovery-storage";
import { wait } from "@/services/async-cancellation";
import { recordQuickAnalysisResult } from "@/services/quick-analysis-registry";
import {
  SITE_URL_MAX_LENGTH,
  isValidEvaluationTargetAccessUrl
} from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  DashboardViewModel,
  EvaluationRequestModel,
  EvaluationStatus
} from "@/types/accessibility-domain";

import {
  ANALYSIS_POLL_ATTEMPTS,
  commitMutationOnce,
  getAnalysisPollDelayMs,
  isDefinitiveMutationRejection,
  reconcileWithRetries,
  runMutationRequestWithDeadline,
  waitForDocumentVisible
} from "../shared/mutation-recovery";
import {
  EVALUATION_REQUEST_FAILED_MESSAGE,
  evaluationRequestPhaseFromStatus
} from "../shared/evaluation-request-status";
import { useMutationOperation } from "../shared/use-mutation-operation";

const QUICK_ANALYSIS_RECONCILE_ATTEMPTS = 4;
const QUICK_ANALYSIS_RECONCILE_INTERVAL_MS = 1000;

type AnalysisPhase =
  | "idle"
  | "requesting"
  | "queued"
  | "running"
  | "completed"
  | "paused"
  | "failed";

type ProgressState = {
  phase: AnalysisPhase;
  requestId: number | null;
  status: EvaluationStatus | string | null;
  message: string;
};

type QuickAnalysisCheckpointBase = {
  attemptId: string;
  startedAt: number;
  url: string;
};

type QuickAnalysisCheckpoint = QuickAnalysisCheckpointBase & (
  | {
      kind: "reconciling";
      knownRequestIds: number[];
    }
  | {
      kind: "request";
      requestId: number;
      targetId: number | null;
      status: string | null;
      updatedAt: string | null;
    }
  | {
      kind: "target";
      requestId: number;
      targetId: number;
      updatedAt: string | null;
    }
);

const emptyProgress: ProgressState = {
  phase: "idle",
  requestId: null,
  status: null,
  message: ""
};

const QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE =
  "이전 분석 정보를 브라우저에 저장하지 못해 새 분석을 시작하지 않았습니다. 브라우저 저장 공간과 설정을 확인해 주세요.";
const QUICK_ANALYSIS_BLOCKED_RECOVERY_MESSAGE =
  "확인할 수 없는 이전 분석 작업이 남아 있어 중복 요청을 막았습니다. 로그아웃한 뒤 다시 시도해 주세요.";
const QUICK_ANALYSIS_DIFFERENT_URL_MESSAGE =
  "이전 페이지의 분석 결과를 먼저 확인해야 합니다. 진행 중이던 주소로 되돌렸습니다.";

const analysisJourneySteps = ["페이지 연결", "접근성 검사", "결과 준비"] as const;

function phaseFromRequestStatus(status: EvaluationStatus | string): AnalysisPhase {
  return evaluationRequestPhaseFromStatus(status);
}

function messageFromRequestStatus(status: EvaluationStatus | string): string {
  if (status === "PENDING") {
    return "분석 요청이 대기열에 등록되었습니다.";
  }
  if (status === "COMPLETED") {
    return "분석이 완료되었습니다. 결과 화면으로 이동합니다.";
  }
  if (status === "FAILED") {
    return EVALUATION_REQUEST_FAILED_MESSAGE;
  }
  return "페이지 접근성 분석을 진행하고 있습니다.";
}

function labelFromPhase(phase: AnalysisPhase): string {
  if (phase === "requesting") {
    return "분석 요청 중";
  }
  if (phase === "queued") {
    return "대기열 등록 중";
  }
  if (phase === "running") {
    return "페이지 분석 중";
  }
  if (phase === "completed") {
    return "결과 준비 완료";
  }
  if (phase === "paused") {
    return "상태 확인 필요";
  }
  if (phase === "failed") {
    return "분석 실패";
  }
  return "분석 준비";
}

function journeyStepIndexFromPhase(phase: AnalysisPhase): number {
  if (phase === "requesting" || phase === "queued") {
    return 0;
  }
  if (phase === "running" || phase === "paused" || phase === "failed") {
    return 1;
  }
  if (phase === "completed") {
    return 2;
  }
  return 0;
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function isLikelyUrl(value: string): boolean {
  return isValidEvaluationTargetAccessUrl(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function toComparableUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

async function runQuickAnalysisRequestWithTimeout<T>({
  operation,
  signal,
  timeoutMessage
}: {
  operation: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal;
  timeoutMessage: string;
}): Promise<T> {
  return runMutationRequestWithDeadline({ operation, signal, timeoutMessage });
}

function requestCheckpointFromResponse(
  url: string,
  request: EvaluationRequestModel,
  recovery: Pick<QuickAnalysisCheckpointBase, "attemptId" | "startedAt">
): Extract<QuickAnalysisCheckpoint, { kind: "request" }> | null {
  if (!isPositiveSafeInteger(request?.id)) {
    return null;
  }

  return {
    kind: "request",
    ...recovery,
    url,
    requestId: request.id,
    targetId: isPositiveSafeInteger(request.evaluationTargetId)
      ? request.evaluationTargetId
      : null,
    status: typeof request.status === "string" ? request.status : null,
    updatedAt: typeof request.updatedAt === "string" ? request.updatedAt : null
  };
}

function checkpointFromPersistedQuickAnalysisAttempt(
  attempt: PersistedQuickAnalysisAttempt
): QuickAnalysisCheckpoint {
  const common = {
    attemptId: attempt.attemptId,
    startedAt: attempt.startedAt,
    url: attempt.url
  };
  if (attempt.phase === "request") {
    return {
      ...common,
      kind: "request",
      requestId: attempt.requestId,
      targetId: attempt.targetId,
      status: attempt.status,
      updatedAt: attempt.updatedAt
    };
  }
  if (attempt.phase === "target") {
    return {
      ...common,
      kind: "target",
      requestId: attempt.requestId,
      targetId: attempt.targetId,
      updatedAt: attempt.updatedAt
    };
  }
  return {
    ...common,
    kind: "reconciling",
    knownRequestIds: attempt.knownRequestIds
  };
}

function persistedAttemptFromQuickAnalysisCheckpoint(
  checkpoint: QuickAnalysisCheckpoint
): PersistedQuickAnalysisAttempt {
  const common = {
    version: 1 as const,
    attemptId: checkpoint.attemptId,
    apiScope: API_BASE_URL,
    startedAt: checkpoint.startedAt,
    url: checkpoint.url
  };
  if (checkpoint.kind === "request") {
    return {
      ...common,
      phase: "request",
      requestId: checkpoint.requestId,
      targetId: checkpoint.targetId,
      status: checkpoint.status,
      updatedAt: checkpoint.updatedAt
    };
  }
  if (checkpoint.kind === "target") {
    return {
      ...common,
      phase: "target",
      requestId: checkpoint.requestId,
      targetId: checkpoint.targetId,
      updatedAt: checkpoint.updatedAt
    };
  }
  return {
    ...common,
    phase: "reconciling",
    knownRequestIds: checkpoint.knownRequestIds
  };
}

function findReconciledQuickAnalysisRequest(
  data: DashboardViewModel,
  checkpoint: Extract<QuickAnalysisCheckpoint, { kind: "reconciling" }>
): EvaluationRequestModel | null {
  const comparableUrl = toComparableUrl(checkpoint.url);
  if (comparableUrl === null) {
    return null;
  }

  const matchingTargetIds = new Set(
    data.organizations.flatMap((organization) =>
      organization.evaluationTargets
        .filter((target) => toComparableUrl(target.accessUrl) === comparableUrl)
        .map((target) => target.id)
    )
  );
  const knownRequestIds = new Set(checkpoint.knownRequestIds);
  const candidates = data.evaluationRequests.filter(
    (request) =>
      matchingTargetIds.has(request.evaluationTargetId) &&
      !knownRequestIds.has(request.id)
  );

  // Without a backend correlation key, choosing between multiple new requests
  // could attach this UI to another actor's analysis. Keep reconciling instead.
  return candidates.length === 1 ? candidates[0] : null;
}

export function QuickAnalyzePanel({
  isDarkMode,
  onAnalysisComplete,
  readOnly = false
}: {
  isDarkMode: boolean;
  onAnalysisComplete: (route: { projectId: number; siteId: number }) => void | Promise<void>;
  readOnly?: boolean;
}) {
  const initialRecoveryRef = useRef<ReturnType<typeof readQuickAnalysisRecovery> | null>(null);
  if (initialRecoveryRef.current === null) {
    initialRecoveryRef.current = readOnly
      ? { kind: "none" }
      : readQuickAnalysisRecovery();
  }
  const initialRecovery = initialRecoveryRef.current;
  const restoredAttempt = initialRecovery.kind === "valid" ? initialRecovery.value : null;
  const [urlInput, setUrlInput] = useState(restoredAttempt?.url ?? "");
  const [errorMessage, setErrorMessage] = useState(
    initialRecovery.kind === "blocked" ? QUICK_ANALYSIS_BLOCKED_RECOVERY_MESSAGE : ""
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(emptyProgress);
  const {
    beginMutationOperation,
    cancelMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent,
    isMutationOperationLocked
  } = useMutationOperation();
  const checkpointRef = useRef<QuickAnalysisCheckpoint | null>(
    restoredAttempt === null
      ? null
      : checkpointFromPersistedQuickAnalysisAttempt(restoredAttempt)
  );
  const checkpointRawValueRef = useRef<string | null>(
    initialRecovery.kind === "valid" ? initialRecovery.rawValue : null
  );
  const recoveryBlockedRef = useRef(initialRecovery.kind === "blocked");

  const persistCheckpoint = (
    checkpoint: QuickAnalysisCheckpoint | PersistedQuickAnalysisAttempt,
    expectedRawValue = checkpointRawValueRef.current
  ): boolean => {
    const attempt = "kind" in checkpoint
      ? persistedAttemptFromQuickAnalysisCheckpoint(checkpoint)
      : checkpoint;
    const stored = writeQuickAnalysisAttempt(attempt, expectedRawValue);
    if (stored === null) {
      return false;
    }
    checkpointRawValueRef.current = stored.rawValue;
    return true;
  };

  const clearPersistedCheckpoint = (): boolean => {
    const rawValue = checkpointRawValueRef.current;
    if (rawValue === null || !clearQuickAnalysisAttempt(rawValue)) {
      return false;
    }
    checkpointRawValueRef.current = null;
    return true;
  };

  const showProgressView = progress.phase !== "idle";
  const isBusy =
    isSubmitting ||
    (progress.phase !== "idle" &&
      progress.phase !== "paused" &&
      progress.phase !== "failed" &&
      progress.phase !== "completed");
  const hasUrlInput = urlInput.trim().length > 0;
  const canSubmit = hasUrlInput && !isBusy && !readOnly;
  const hasError = errorMessage.length > 0;

  const handleReset = () => {
    cancelMutationOperation();
    setProgress(emptyProgress);
    setErrorMessage("");
    setIsSubmitting(false);
  };

  const handleSubmit = async () => {
    if (readOnly) {
      return;
    }
    if (isMutationOperationLocked() || !hasUrlInput) {
      return;
    }

    if (recoveryBlockedRef.current) {
      setErrorMessage(QUICK_ANALYSIS_BLOCKED_RECOVERY_MESSAGE);
      return;
    }

    const normalized = normalizeUrl(urlInput);
    if (!isLikelyUrl(normalized)) {
      setErrorMessage("올바른 페이지 주소를 입력해 주세요. 예: https://example.com");
      return;
    }

    const operation = beginMutationOperation("quick-analysis-operation");
    if (operation === null) {
      return;
    }
    const { signal } = operation;
    const isActiveOperation = () => isMutationOperationCurrent(operation);

    setIsSubmitting(true);
    setErrorMessage("");
    setProgress({
      phase: "requesting",
      requestId: null,
      status: null,
      message: "분석 요청을 생성하고 있습니다."
    });
    let terminalRequestFailed = false;
    let requiresInputReset = false;

    try {
      let checkpoint = checkpointRef.current;
      if (checkpoint !== null && checkpoint.url !== normalized) {
        requiresInputReset = true;
        setUrlInput(checkpoint.url);
        throw new UserFacingError(QUICK_ANALYSIS_DIFFERENT_URL_MESSAGE);
      }

      if (checkpoint === null) {
        // Capture the request baseline before POST. If the POST response is
        // lost, later attempts can recover exactly one new request for this URL
        // without sending the mutation again.
        const baseline = await runQuickAnalysisRequestWithTimeout({
          signal,
          timeoutMessage: "분석을 준비하는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.",
          operation: (requestSignal) =>
            fetchDashboardViewModel(requestSignal)
        });
        if (!isActiveOperation()) {
          return;
        }

        const attemptId = window.crypto.randomUUID();
        const startedAt = Date.now();
        const knownRequestIds = baseline.evaluationRequests.map((request) => request.id);
        const postingAttempt: PersistedQuickAnalysisAttempt = {
          version: 1,
          attemptId,
          apiScope: API_BASE_URL,
          startedAt,
          url: normalized,
          phase: "posting",
          knownRequestIds
        };
        if (!persistCheckpoint(postingAttempt, null)) {
          throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
        }

        const reconcilingCheckpoint: Extract<
          QuickAnalysisCheckpoint,
          { kind: "reconciling" }
        > = {
          kind: "reconciling",
          attemptId,
          startedAt,
          url: normalized,
          knownRequestIds
        };
        checkpointRef.current = reconcilingCheckpoint;
        checkpoint = reconcilingCheckpoint;

        try {
          const commitOutcome = await commitMutationOnce({
            signal,
            timeoutMessage: "분석을 시작하는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.",
            operation: (requestSignal) =>
              startUrlEvaluation(normalized, requestSignal),
            accept: (created) => {
              const requestCheckpoint = requestCheckpointFromResponse(normalized, created, {
                attemptId,
                startedAt
              });
              return requestCheckpoint !== null &&
                !knownRequestIds.includes(requestCheckpoint.requestId)
                ? requestCheckpoint
                : null;
            }
          });
          if (!isActiveOperation()) {
            return;
          }

          if (commitOutcome.kind === "accepted") {
            if (!persistCheckpoint(commitOutcome.value)) {
              throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
            }
            checkpointRef.current = commitOutcome.value;
            checkpoint = commitOutcome.value;
          }
        } catch (error) {
          if (isDefinitiveMutationRejection(error)) {
            if (!clearPersistedCheckpoint()) {
              throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
            }
            checkpointRef.current = null;
            throw error;
          }
          throw error;
        }

        if (checkpoint.kind === "reconciling") {
          if (
            !persistCheckpoint(checkpoint)
          ) {
            throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
          }
        }
      }

      if (checkpoint.kind === "reconciling") {
        const reconcilingCheckpoint = checkpoint;
        const recoveredCheckpoint = await reconcileWithRetries({
          attempts: QUICK_ANALYSIS_RECONCILE_ATTEMPTS,
          intervalMs: QUICK_ANALYSIS_RECONCILE_INTERVAL_MS,
          signal,
          probe: async (requestSignal) => {
            const reconciledData = await runQuickAnalysisRequestWithTimeout({
              signal: requestSignal,
              timeoutMessage: "분석 진행 상태를 확인하는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.",
              operation: (probeSignal) => fetchDashboardViewModel(probeSignal)
            });
            if (!isActiveOperation()) {
              return null;
            }
            const reconciledRequest = findReconciledQuickAnalysisRequest(
              reconciledData,
              reconcilingCheckpoint
            );
            return reconciledRequest === null
              ? null
              : requestCheckpointFromResponse(normalized, reconciledRequest, {
                  attemptId: reconcilingCheckpoint.attemptId,
                  startedAt: reconcilingCheckpoint.startedAt
                });
          }
        });

        if (recoveredCheckpoint === null) {
          throw new UserFacingError(
            "분석 요청의 처리 결과를 아직 확인하지 못했습니다. 잠시 후 다시 시도해 주세요. 새 분석 요청은 보내지 않습니다."
          );
        }
        if (!persistCheckpoint(recoveredCheckpoint)) {
          throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
        }
        checkpointRef.current = recoveredCheckpoint;
        checkpoint = recoveredCheckpoint;
      }

      if (checkpoint.kind === "request") {
        let requestCheckpoint = checkpoint;
        if (requestCheckpoint.status !== null) {
          setProgress({
            phase: phaseFromRequestStatus(requestCheckpoint.status),
            requestId: requestCheckpoint.requestId,
            status: requestCheckpoint.status,
            message: messageFromRequestStatus(requestCheckpoint.status)
          });
        }

        if (requestCheckpoint.status === "FAILED") {
          terminalRequestFailed = true;
          if (!clearPersistedCheckpoint()) {
            throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
          }
          checkpointRef.current = null;
          throw new UserFacingError(EVALUATION_REQUEST_FAILED_MESSAGE);
        }

        if (requestCheckpoint.status !== "COMPLETED" || requestCheckpoint.targetId === null) {
          let reachedUsableFinalRequest = false;
          for (let attempt = 0; attempt < ANALYSIS_POLL_ATTEMPTS; attempt += 1) {
            await waitForDocumentVisible(signal);
            if (attempt > 0) {
              await wait(getAnalysisPollDelayMs(attempt), signal);
              await waitForDocumentVisible(signal);
            }

            const request = await runQuickAnalysisRequestWithTimeout({
              signal,
              timeoutMessage: "분석 진행 상태를 확인하는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.",
              operation: (requestSignal) =>
                fetchEvaluationRequest(requestCheckpoint.requestId, requestSignal)
            });
            if (!isActiveOperation()) {
              return;
            }

            const nextCheckpoint = requestCheckpointFromResponse(normalized, request, {
              attemptId: requestCheckpoint.attemptId,
              startedAt: requestCheckpoint.startedAt
            });
            if (nextCheckpoint === null) {
              throw new UserFacingError("분석 진행 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
            }
            if (
              !persistCheckpoint(nextCheckpoint)
            ) {
              throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
            }
            requestCheckpoint = nextCheckpoint;
            checkpointRef.current = requestCheckpoint;
            setProgress({
              phase: phaseFromRequestStatus(request.status),
              requestId: requestCheckpoint.requestId,
              status: request.status,
              message: messageFromRequestStatus(request.status)
            });

            if (request.status === "FAILED") {
              terminalRequestFailed = true;
              if (!clearPersistedCheckpoint()) {
                throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
              }
              checkpointRef.current = null;
              throw new UserFacingError(EVALUATION_REQUEST_FAILED_MESSAGE);
            }
            if (request.status === "COMPLETED" && requestCheckpoint.targetId !== null) {
              reachedUsableFinalRequest = true;
              break;
            }
          }

          if (!reachedUsableFinalRequest) {
            throw new UserFacingError("페이지 검사에 예상보다 오래 걸리고 있습니다. 잠시 후 결과를 다시 확인해 주세요.");
          }
        }

        if (requestCheckpoint.status !== "COMPLETED" || requestCheckpoint.targetId === null) {
          throw new UserFacingError("완료된 분석 결과를 찾지 못했습니다. 결과 목록을 다시 불러와 주세요.");
        }

        const targetCheckpoint: Extract<QuickAnalysisCheckpoint, { kind: "target" }> = {
          kind: "target",
          attemptId: requestCheckpoint.attemptId,
          startedAt: requestCheckpoint.startedAt,
          url: normalized,
          requestId: requestCheckpoint.requestId,
          targetId: requestCheckpoint.targetId,
          updatedAt: requestCheckpoint.updatedAt
        };
        if (
          !persistCheckpoint(targetCheckpoint)
        ) {
          throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
        }
        checkpointRef.current = targetCheckpoint;
        checkpoint = targetCheckpoint;
      }

      if (checkpoint.kind !== "target") {
        throw new UserFacingError("분석 결과를 찾지 못했습니다. 결과 목록을 다시 불러와 주세요.");
      }

      const target = await runQuickAnalysisRequestWithTimeout({
        signal,
        timeoutMessage: "분석 결과를 불러오는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.",
        operation: (requestSignal) =>
          fetchEvaluationTarget(checkpoint.targetId, requestSignal)
      });
      if (!isActiveOperation()) {
        return;
      }
      if (
        target.status !== "ACTIVE" ||
        toComparableUrl(target.accessUrl) !== toComparableUrl(normalized)
      ) {
        throw new UserFacingError(
          "완료된 분석 결과가 현재 페이지와 일치하지 않습니다. 결과 목록에서 다시 확인해 주세요."
        );
      }
      const completedTimestamp = Date.parse(checkpoint.updatedAt ?? "");
      recordQuickAnalysisResult({
        projectId: target.organizationId,
        pageId: target.id,
        timestamp: Number.isFinite(completedTimestamp) ? completedTimestamp : Date.now()
      });
      setProgress({
        phase: "completed",
        requestId: checkpoint.requestId,
        status: "COMPLETED",
        message: "분석이 완료되었습니다. 결과 화면으로 이동합니다."
      });
      await wait(350, signal);
      try {
        await onAnalysisComplete({
          projectId: target.organizationId,
          siteId: target.id
        });
      } catch (error) {
        if (!isActiveOperation() || isAbortError(error)) {
          return;
        }
        const message = getApiErrorMessage(
          error,
          "분석은 완료되었지만 결과를 불러오지 못했습니다."
        );
        setErrorMessage(message);
        setProgress({
          phase: "completed",
          requestId: checkpoint.requestId,
          status: "COMPLETED",
          message
        });
        return;
      }
      if (!clearPersistedCheckpoint()) {
        throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
      }
      checkpointRef.current = null;
    } catch (error) {
      if (!isActiveOperation() || isAbortError(error)) {
        return;
      }

      const message = getApiErrorMessage(error, "페이지 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setErrorMessage(message);
      setProgress((current) => ({
        ...current,
        phase:
          terminalRequestFailed || requiresInputReset || checkpointRef.current === null
            ? "failed"
            : "paused",
        message
      }));
    } finally {
      if (finishMutationOperation(operation)) {
        setIsSubmitting(false);
      }
    }
  };

  const journeyStepIndex = journeyStepIndexFromPhase(progress.phase);

  return (
    <div className="quick-analyze-layout relative min-h-0 w-full flex-1">
      <article
        className="absolute left-1/2 top-[40%] w-full max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-[28px] bg-transparent p-5 sm:max-w-2xl sm:p-7 lg:max-w-3xl lg:p-8"
      >
        {showProgressView && (
          <div className="mb-8 text-center sm:mb-10">
            <h2
              className={`text-2xl font-black tracking-tight sm:text-3xl ${
                isDarkMode ? "text-white" : "text-slate-900"
              }`}
            >
              {progress.phase === "failed"
                ? "분석을 완료하지 못했습니다"
                : progress.phase === "paused"
                  ? "분석 상태를 다시 확인해 주세요"
                : progress.phase === "completed"
                  ? "분석이 완료되었습니다"
                  : "페이지를 분석하고 있습니다"}
            </h2>
          </div>
        )}

        {!showProgressView ? (
          <div>
            <h2
              className={`mb-8 text-center text-2xl font-black tracking-tight sm:mb-10 sm:text-3xl ${
                isDarkMode ? "text-white" : "text-slate-900"
              }`}
            >
              확인할 페이지 주소를 입력하세요
            </h2>
            <label htmlFor="quick-analyze-url" className="sr-only">
              페이지 주소
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div
                className={`relative flex h-11 min-w-0 flex-1 items-center rounded-[10px] border transition-colors ${
                  hasError
                    ? isDarkMode
                      ? "border-[#ff453a] bg-[#2c2c2e] focus-within:border-[#ff453a]"
                      : "border-[#d70015] bg-[#e5e5ea] focus-within:border-[#d70015]"
                    : isDarkMode
                      ? "border-transparent bg-[#2c2c2e] focus-within:border-white"
                      : "border-transparent bg-[#e5e5ea] focus-within:border-[#1d1d1f]"
                }`}
              >
                <Search
                  size={16}
                  strokeWidth={2}
                  aria-hidden="true"
                  className={`pointer-events-none absolute left-3 shrink-0 ${
                    hasError ? "text-[#ff453a]" : "text-[#8e8e93]"
                  }`}
                />
                <input
                  id="quick-analyze-url"
                  value={urlInput}
                  onChange={(event) => {
                    setUrlInput(event.target.value);
                    if (errorMessage.length > 0) {
                      setErrorMessage("");
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canSubmit) {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                  disabled={isBusy}
                  maxLength={SITE_URL_MAX_LENGTH}
                  aria-invalid={hasError}
                  aria-describedby={hasError ? "quick-analyze-url-error" : undefined}
                  readOnly={readOnly}
                  placeholder="https://example.com"
                  className={`h-full w-full min-w-0 rounded-[inherit] border-0 bg-transparent pl-9 pr-3 text-sm outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                    isDarkMode
                      ? "text-[#f5f5f7] placeholder:text-[#8e8e93]"
                      : "text-[#1d1d1f] placeholder:text-[#86868b]"
                  }`}
                />
              </div>
              <button
                type="button"
                disabled={!canSubmit || readOnly}
                onClick={() => {
                  void handleSubmit();
                }}
                className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[#0071e3] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#0066cc] disabled:cursor-not-allowed disabled:bg-[#3a3a3c] disabled:text-[#8e8e93] sm:w-auto sm:min-w-[7.5rem]"
              >
                {isBusy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                <span>{isBusy ? "분석 중..." : "분석 시작"}</span>
                {!isBusy && <ArrowRight size={15} aria-hidden="true" />}
              </button>
            </div>
            {hasError && (
              <p id="quick-analyze-url-error" className="mt-2 text-left text-xs text-[#ff453a]">
                {errorMessage}
              </p>
            )}
          </div>
        ) : (
          <section className="mx-auto w-full max-w-2xl" aria-live="polite" aria-busy={isBusy}>
            <p
              className={`mb-6 text-center text-sm font-medium ${
                progress.phase === "failed"
                  ? "text-[#ff453a]"
                  : isDarkMode
                    ? "text-[#a1a1a6]"
                    : "text-[#6e6e73]"
              }`}
            >
              {labelFromPhase(progress.phase)}
            </p>

            <Stepper
              value={journeyStepIndex + 1}
              role="group"
              aria-label="분석 진행 단계"
              indicators={{
                completed: <Check className="size-3.5" strokeWidth={2.5} aria-hidden="true" />,
                loading: <Loader2 className="size-3.5 animate-spin" strokeWidth={2.5} aria-hidden="true" />
              }}
            >
              <StepperNav className="items-start px-2 sm:px-8" aria-label="URL 분석 과정">
                {analysisJourneySteps.map((step, index) => {
                  const stepNumber = index + 1;
                  const isCompletedStep = progress.phase === "completed" || index < journeyStepIndex;
                  const isFailedStep = progress.phase === "failed" && index === journeyStepIndex;
                  const isActiveStep =
                    !isCompletedStep &&
                    !isFailedStep &&
                    index === journeyStepIndex &&
                    progress.phase !== "idle" &&
                    progress.phase !== "paused";

                  return (
                    <StepperItem
                      key={step}
                      step={stepNumber}
                      completed={isCompletedStep}
                      loading={isActiveStep}
                      aria-current={isActiveStep ? "step" : undefined}
                    >
                      <StepperTrigger
                        asChild
                        className="pointer-events-none flex min-w-[4.75rem] shrink-0 flex-col items-center gap-2"
                      >
                        <StepperIndicator
                          className={`size-7 border ${
                            isFailedStep
                              ? "border-[#ff453a] bg-[#ff453a] text-white"
                              : isDarkMode
                                ? "border-[#3a3a3c] bg-[#242426] text-[#8e8e93]"
                                : "border-[#d2d2d7] bg-[#f5f5f7] text-[#86868b]"
                          } data-[state=active]:border-[#0071e3] data-[state=active]:bg-[#0071e3] data-[state=active]:text-white data-[state=completed]:border-[#0071e3] data-[state=completed]:bg-[#0071e3] data-[state=completed]:text-white`}
                        >
                          {isFailedStep ? (
                            <X className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
                          ) : (
                            stepNumber
                          )}
                        </StepperIndicator>
                        <StepperTitle
                          className={`whitespace-nowrap text-xs ${
                            isFailedStep
                              ? "text-[#ff453a]"
                              : isActiveStep || isCompletedStep
                                ? isDarkMode
                                  ? "text-[#f5f5f7]"
                                  : "text-[#1d1d1f]"
                                : isDarkMode
                                  ? "text-[#636366]"
                                  : "text-[#86868b]"
                          }`}
                        >
                          {step}
                        </StepperTitle>
                      </StepperTrigger>
                      {stepNumber < analysisJourneySteps.length && (
                        <StepperSeparator
                          className={`mt-3 ${
                            isDarkMode ? "bg-[#3a3a3c]" : "bg-[#d2d2d7]"
                          } group-data-[state=completed]/step:bg-[#0071e3]`}
                        />
                      )}
                    </StepperItem>
                  );
                })}
              </StepperNav>
            </Stepper>

            {urlInput.trim().length > 0 && (
              <p className={`mt-7 truncate text-center text-xs ${isDarkMode ? "text-[#8e8e93]" : "text-[#86868b]"}`}>
                {normalizeUrl(urlInput)}
              </p>
            )}

            {progress.phase === "failed" && (
              <div className="mt-6 flex flex-col items-center gap-3">
                <p className="text-center text-xs text-rose-500">{errorMessage || progress.message}</p>
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[#0071e3] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#0066cc]"
                >
                  다시 시도
                </button>
              </div>
            )}

            {progress.phase === "paused" && (
              <div className="mt-6 flex flex-col items-center gap-3">
                <p className="text-center text-xs text-amber-600">{errorMessage || progress.message}</p>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => {
                    void handleSubmit();
                  }}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[#0071e3] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#0066cc] disabled:cursor-wait disabled:opacity-60"
                >
                  {isSubmitting ? "상태 확인 중..." : "상태 다시 확인"}
                </button>
              </div>
            )}

            {progress.phase === "completed" && hasError && (
              <div className="mt-6 flex flex-col items-center gap-3">
                <p className="text-center text-xs text-amber-600">{errorMessage}</p>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => {
                    void handleSubmit();
                  }}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[#0071e3] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#0066cc] disabled:cursor-wait disabled:opacity-60"
                >
                  {isSubmitting ? "결과 불러오는 중..." : "결과 다시 불러오기"}
                </button>
              </div>
            )}
          </section>
        )}
      </article>
    </div>
  );
}
