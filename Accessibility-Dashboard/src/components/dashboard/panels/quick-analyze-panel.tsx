import { ArrowRight, Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { API_BASE_URL } from "@/config/api";
import {
  fetchDashboardViewModel,
  fetchEvaluationRequest,
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

import {
  SITE_URL_MAX_LENGTH,
  isValidEvaluationTargetAccessUrl
} from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  DashboardViewModel,
  EvaluationRequestModel
} from "@/types/accessibility-domain";

import {
  commitMutationOnce,
  isDefinitiveMutationRejection,
  reconcileWithRetries,
  runMutationRequestWithDeadline
} from "../shared/mutation-recovery";

import { useMutationOperation } from "../shared/use-mutation-operation";
import { QuickAnalysisProgress } from "./quick-analysis-progress";

const QUICK_ANALYSIS_RECONCILE_ATTEMPTS = 4;
const QUICK_ANALYSIS_RECONCILE_INTERVAL_MS = 1000;

type QuickAnalysisPhase = "idle" | "requesting" | "paused" | "failed";

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

const QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE =
  "이전 분석 정보를 브라우저에 저장하지 못해 새 분석을 시작하지 않았습니다. 브라우저 저장 공간과 설정을 확인해 주세요.";
const QUICK_ANALYSIS_BLOCKED_RECOVERY_MESSAGE =
  "확인할 수 없는 이전 분석 작업이 남아 있어 중복 요청을 막았습니다. 로그아웃한 뒤 다시 시도해 주세요.";
const QUICK_ANALYSIS_DIFFERENT_URL_MESSAGE =
  "이전 주소의 접수 여부를 먼저 확인해야 합니다. 중복 접수를 막기 위해 기존 주소로 되돌렸습니다.";



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
  onAnalysisAccepted,
  readOnly
}: {
  isDarkMode: boolean;
} & (
  | { readOnly: true; onAnalysisAccepted?: never }
  | {
      readOnly?: false;
      onAnalysisAccepted: (request: EvaluationRequestModel, url: string) => void;
    }
)) {
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
  const [acceptedMessage, setAcceptedMessage] = useState("");
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<QuickAnalysisPhase>("idle");
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

  const showProgressView = phase !== "idle";
  const isBusy = isSubmitting || phase === "requesting";
  const hasUrlInput = urlInput.trim().length > 0;
  const canSubmit = hasUrlInput && !isBusy && !readOnly;
  const hasError = errorMessage.length > 0;

  useEffect(() => {
    const restored = checkpointRef.current;
    if (readOnly || !restored || restored.kind === "reconciling" || restored.targetId === null) return;
    onAnalysisAccepted({
      id: restored.requestId,
      evaluationTargetId: restored.targetId,
      status: restored.kind === "target" ? "COMPLETED" : (restored.status as EvaluationRequestModel["status"] ?? "PENDING"),
      requestedAt: new Date(restored.startedAt).toISOString(),
      updatedAt: restored.updatedAt ?? ""
    }, restored.url);
    if (clearPersistedCheckpoint()) {
      checkpointRef.current = null;
      setUrlInput("");
      setAcceptedMessage("접수된 분석은 사이드바에서 확인할 수 있습니다. 다음 주소를 입력해 주세요.");
    }
    // Consume mount-time recovery once; the dashboard owns ongoing requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, onAnalysisAccepted]);

  const handleReset = () => {
    cancelMutationOperation();
    setPhase("idle");
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
    setPhase("requesting");

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

      // A positive receipt releases this form. Status/result reads are owned by
      // the dashboard and cannot hold the next submission hostage.
      if (checkpoint.targetId === null) {
        const requestId = checkpoint.requestId;
        const request = await runQuickAnalysisRequestWithTimeout({
          signal,
          timeoutMessage: "분석 접수 정보를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.",
          operation: (requestSignal) => fetchEvaluationRequest(requestId, requestSignal)
        });
        const recovered = requestCheckpointFromResponse(normalized, request, checkpoint);
        if (!isActiveOperation()) return;
        if (!recovered || recovered.requestId !== requestId || recovered.targetId === null) {
          throw new UserFacingError("분석 접수 정보를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.");
        }
        checkpoint = recovered;
        checkpointRef.current = recovered;
        if (!persistCheckpoint(recovered)) throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
      }
      onAnalysisAccepted({
        id: checkpoint.requestId,
        evaluationTargetId: checkpoint.targetId!,
        status: checkpoint.kind === "target" ? "COMPLETED" : (checkpoint.status as EvaluationRequestModel["status"] ?? "PENDING"),
        requestedAt: new Date(checkpoint.startedAt).toISOString(),
        updatedAt: checkpoint.updatedAt ?? ""
      }, normalized);
      if (!clearPersistedCheckpoint()) {
        throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
      }
      checkpointRef.current = null;
      setUrlInput("");
      setPhase("idle");
      setAcceptedMessage("분석을 접수했습니다. 사이드바에서 진행 상태를 확인하고 다음 주소를 입력해 주세요.");
      window.requestAnimationFrame(() => urlInputRef.current?.focus());
    } catch (error) {
      if (!isActiveOperation() || isAbortError(error)) {
        return;
      }

      const message = getApiErrorMessage(error, "페이지 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setErrorMessage(message);
      setPhase(requiresInputReset || checkpointRef.current === null ? "failed" : "paused");
    } finally {
      if (finishMutationOperation(operation)) {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <div className={`quick-analyze-layout min-h-0 w-full flex-1 ${showProgressView ? "quick-analyze-layout--progress" : "relative"}`}>
      <article
        className={showProgressView ? "quick-analyze-progress-panel" : "absolute left-1/2 top-[40%] w-full max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-[28px] bg-transparent p-5 sm:max-w-2xl sm:p-7 lg:max-w-3xl lg:p-8"}
      >
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
                className={`quick-analyze-input-shell relative flex h-11 min-h-11 min-w-0 flex-none items-center rounded-[10px] border transition-colors sm:flex-1 ${
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
                  ref={urlInputRef}
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
                className="quick-analyze-submit inline-flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[#0071e3] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#0066cc] disabled:cursor-not-allowed disabled:bg-[#3a3a3c] disabled:text-[#8e8e93] sm:w-auto sm:min-w-[7.5rem]"
              >
                {isBusy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                <span>{isBusy ? "분석 중..." : "분석 시작"}</span>
                {!isBusy && <ArrowRight size={15} aria-hidden="true" />}
              </button>
            </div>
            {acceptedMessage && <p role="status" className="mt-3 text-center text-xs text-[var(--dashboard-text-muted)]">{acceptedMessage}</p>}
            {hasError && (
              <p id="quick-analyze-url-error" className="mt-2 text-left text-xs text-[#ff453a]">
                {errorMessage}
              </p>
            )}
          </div>
        ) : (
          <QuickAnalysisProgress phase={phase} url={normalizeUrl(urlInput)} isBusy={isBusy}>
            {phase === "failed" && (
              <div className="mt-6 flex flex-col items-center gap-3">
                <p role="alert" className="text-center text-xs text-rose-500">{errorMessage}</p>
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-[#0071e3] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#0066cc]"
                >
                  다시 시도
                </button>
              </div>
            )}

            {phase === "paused" && (
              <div className="mt-6 flex flex-col items-center gap-3">
                <p role="alert" className="text-center text-xs text-amber-600">{errorMessage}</p>
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
          </QuickAnalysisProgress>
        )}
      </article>
    </div>
  );
}
