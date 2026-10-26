import { fetchAnalysisAttempt, startUrlEvaluation } from "@/services/analysis-protocol-api";
import { ArrowRight, Loader2, Search } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";

import { API_BASE_URL } from "@/config/api";
import { preventAccidentalSubmit } from "../shared/form-keyboard";
import {
  fetchDashboardViewModel,
  fetchEvaluationRequest,
  getApiErrorMessage,
  isAbortError,
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
import { createRandomUuid } from "@/services/random-uuid";
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

import { useMutationOperation, type MutationOperation } from "../shared/use-mutation-operation";
import { QuickAnalysisProgress } from "./quick-analysis-progress";
import { toRequestStatus } from "./quick-analysis-status";

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
      serverKey?: true;
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
type ReconcilingCheckpoint = Extract<QuickAnalysisCheckpoint, { kind: "reconciling" }>;
type QuickAnalysisReceipt = Exclude<QuickAnalysisCheckpoint, { kind: "reconciling" }>;
type QuickAnalysisRecovery = ReturnType<typeof readQuickAnalysisRecovery>;
type AnalysisAcceptedHandler = (request: EvaluationRequestModel, url: string) => void;

const QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE =
  "이전 분석 정보를 브라우저에 저장하지 못해 새 분석을 시작하지 않았습니다. 브라우저 저장 공간과 설정을 확인해 주세요.";
const QUICK_ANALYSIS_BLOCKED_RECOVERY_MESSAGE =
  "확인할 수 없는 이전 분석 작업이 남아 있어 중복 요청을 막았습니다. 로그아웃한 뒤 다시 시도해 주세요.";
const QUICK_ANALYSIS_DIFFERENT_URL_MESSAGE =
  "이전 주소의 접수 여부를 먼저 확인해야 합니다. 중복 접수를 막기 위해 기존 주소로 되돌렸습니다.";
const QUICK_ANALYSIS_PHASE_ANNOUNCEMENTS: Record<QuickAnalysisPhase, string> = {
  idle: "",
  requesting: "현재 상태: 분석 요청 중",
  paused: "현재 상태: 상태 확인 필요",
  failed: "현재 상태: 분석 실패"
};



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
): Extract<QuickAnalysisCheckpoint, { kind: "request" }> {
  return {
    kind: "request",
    ...recovery,
    url,
    requestId: request.id,
    targetId: request.evaluationTargetId,
    status: request.status,
    updatedAt: request.updatedAt
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
    knownRequestIds: attempt.knownRequestIds,
    serverKey: attempt.serverKey
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
    knownRequestIds: checkpoint.knownRequestIds,
    serverKey: checkpoint.serverKey
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

function acceptedRequestFromCheckpoint(checkpoint: QuickAnalysisReceipt): EvaluationRequestModel {
  return {
    id: checkpoint.requestId,
    evaluationTargetId: checkpoint.targetId!,
    status: checkpoint.kind === "target" ? "COMPLETED" : toRequestStatus(checkpoint.status),
    requestedAt: new Date(checkpoint.startedAt).toISOString(),
    updatedAt: checkpoint.updatedAt ?? ""
  };
}

function restoredQuickAnalysisState(recovery: QuickAnalysisRecovery) {
  const restoredAttempt = recovery.kind === "valid" ? recovery.value : null;
  return {
    url: restoredAttempt?.url ?? "",
    errorMessage: recovery.kind === "blocked" ? QUICK_ANALYSIS_BLOCKED_RECOVERY_MESSAGE : "",
    checkpoint: restoredAttempt === null
      ? null
      : checkpointFromPersistedQuickAnalysisAttempt(restoredAttempt),
    rawValue: recovery.kind === "valid" ? recovery.rawValue : null,
    isBlocked: recovery.kind === "blocked"
  };
}

function QuickAnalyzeUrlField({
  inputRef,
  value,
  hasError,
  isBusy,
  readOnly,
  onChange,
  onKeyDown
}: {
  inputRef: RefObject<HTMLInputElement>;
  value: string;
  hasError: boolean;
  isBusy: boolean;
  readOnly?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div
      className={`quick-analyze-input-shell relative flex h-11 min-h-11 min-w-0 flex-none items-center rounded-[10px] border bg-[var(--dashboard-field-bg)] transition-colors sm:flex-1 ${
        hasError
          ? "border-[var(--dashboard-danger-border)] focus-within:border-[var(--dashboard-danger-border)]"
          : "border-transparent focus-within:border-[var(--dashboard-field-focus-border)]"
      }`}
    >
      <Search
        size={16}
        strokeWidth={2}
        aria-hidden="true"
        className={`pointer-events-none absolute left-3 shrink-0 ${
          hasError ? "text-[var(--dashboard-danger-text)]" : "text-[var(--dashboard-field-icon)]"
        }`}
      />
      <input
        ref={inputRef}
        id="quick-analyze-url"
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={isBusy}
        maxLength={SITE_URL_MAX_LENGTH}
        aria-invalid={hasError}
        aria-describedby={hasError ? "quick-analyze-url-error" : undefined}
        readOnly={readOnly}
        placeholder="https://example.com"
        inputMode="url"
        autoComplete="url"
        className="h-full w-full min-w-0 rounded-[inherit] border-0 bg-transparent pl-9 pr-3 text-sm text-[var(--dashboard-text-primary)] outline-none placeholder:text-[var(--dashboard-field-placeholder)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />
    </div>
  );
}

function QuickAnalyzeForm({
  urlField,
  canSubmit,
  isBusy,
  readOnly,
  acceptedMessage,
  errorMessage,
  hasError,
  onSubmit
}: {
  urlField: ReactNode;
  canSubmit: boolean;
  isBusy: boolean;
  readOnly?: boolean;
  acceptedMessage: string;
  errorMessage: string;
  hasError: boolean;
  onSubmit: () => Promise<void>;
}) {
  return (
    <div>
      <h2 className="mb-8 text-center text-2xl font-black tracking-tight text-[var(--dashboard-text-strong)] sm:mb-10 sm:text-3xl">
        확인할 페이지 주소를 입력하세요
      </h2>
      <label htmlFor="quick-analyze-url" className="sr-only">
        페이지 주소
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        {urlField}
        <button
          type="button"
          disabled={!canSubmit || readOnly}
          onClick={() => {
            void onSubmit();
          }}
          className="quick-analyze-submit inline-flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 text-sm font-semibold text-[var(--primary-foreground)] transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-[var(--dashboard-disabled-bg)] disabled:text-[var(--dashboard-disabled-text)] sm:w-auto sm:min-w-[7.5rem]"
        >
          {isBusy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
          <span>{isBusy ? "분석 중..." : "분석 시작"}</span>
          {!isBusy && <ArrowRight size={15} aria-hidden="true" />}
        </button>
      </div>
      {acceptedMessage && <p className="mt-3 text-center text-xs text-[var(--dashboard-text-muted)]">{acceptedMessage}</p>}
      {/* Always mounted as an assertive live region: an alert inserted
          together with its text is often skipped by screen readers.
          The alert role is only exposed while there is a message, so an
          empty region is never reported as an alert. Empty, it has no height. */}
      <p
        id="quick-analyze-url-error"
        aria-live="assertive"
        aria-atomic="true"
        role={hasError ? "alert" : undefined}
        className={hasError ? "mt-2 text-left text-xs text-[var(--dashboard-danger-text)]" : undefined}
      >
        {errorMessage}
      </p>
    </div>
  );
}

function QuickAnalysisRecoveryActions({
  phase,
  errorMessage,
  isSubmitting,
  actionRef,
  onReset,
  onRetry
}: {
  phase: QuickAnalysisPhase;
  errorMessage: string;
  isSubmitting: boolean;
  actionRef: RefObject<HTMLButtonElement>;
  onReset: () => void;
  onRetry: () => Promise<void>;
}) {
  return (
    <>
      {phase === "failed" && (
        <div className="mt-6 flex flex-col items-center gap-3">
          <p role="alert" className="text-center text-xs text-[var(--dashboard-danger-text)]">{errorMessage}</p>
          <button
            ref={actionRef}
            type="button"
            onClick={onReset}
            className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--primary)] px-5 text-sm font-semibold text-[var(--primary-foreground)] transition-colors hover:bg-primary-hover"
          >
            다시 시도
          </button>
        </div>
      )}

      {phase === "paused" && (
        <div className="mt-6 flex flex-col items-center gap-3">
          <p role="alert" className="text-center text-xs text-[var(--dashboard-warning-text)]">{errorMessage}</p>
          <button
            ref={actionRef}
            type="button"
            disabled={isSubmitting}
            onClick={() => {
              void onRetry();
            }}
            className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--primary)] px-5 text-sm font-semibold text-[var(--primary-foreground)] transition-colors hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
          >
            {isSubmitting ? "상태 확인 중..." : "상태 다시 확인"}
          </button>
        </div>
      )}
    </>
  );
}

export function QuickAnalyzePanel({
  onAnalysisAccepted,
  readOnly
}:
  | { readOnly: true; onAnalysisAccepted?: never }
  | {
      readOnly?: false;
      onAnalysisAccepted: AnalysisAcceptedHandler;
    }
) {
  const initialRecoveryRef = useRef<QuickAnalysisRecovery | null>(null);
  if (initialRecoveryRef.current === null) {
    initialRecoveryRef.current = readOnly
      ? { kind: "none" }
      : readQuickAnalysisRecovery();
  }
  const restoredState = restoredQuickAnalysisState(initialRecoveryRef.current);
  const [urlInput, setUrlInput] = useState(restoredState.url);
  const [errorMessage, setErrorMessage] = useState(restoredState.errorMessage);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [acceptedMessage, setAcceptedMessage] = useState("");
  const urlInputRef = useRef<HTMLInputElement>(null);
  const progressHeadingRef = useRef<HTMLHeadingElement>(null);
  const progressActionRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [phase, setPhase] = useState<QuickAnalysisPhase>("idle");
  const previousPhaseRef = useRef<QuickAnalysisPhase>(phase);
  const {
    beginMutationOperation,
    cancelMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent,
    isMutationOperationLocked
  } = useMutationOperation();
  const checkpointRef = useRef<QuickAnalysisCheckpoint | null>(restoredState.checkpoint);
  const checkpointRawValueRef = useRef<string | null>(restoredState.rawValue);
  const recoveryBlockedRef = useRef(restoredState.isBlocked);

  const persistCheckpoint = (
    checkpoint: QuickAnalysisCheckpoint | PersistedQuickAnalysisAttempt,
    expectedRawValue = checkpointRawValueRef.current
  ): void => {
    const attempt = "kind" in checkpoint
      ? persistedAttemptFromQuickAnalysisCheckpoint(checkpoint)
      : checkpoint;
    let failureMessage = QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE;
    const stored = writeQuickAnalysisAttempt(attempt, expectedRawValue, reason => {
      failureMessage = reason === "quota"
        ? "브라우저 저장 공간이 부족해 분석 복구 정보를 저장하지 못했습니다. 저장 공간을 확보한 뒤 다시 확인해 주세요."
        : reason === "unavailable"
          ? "브라우저 저장소에 접근하지 못해 분석 복구 정보를 저장하지 못했습니다. 브라우저 저장 공간과 설정을 확인해 주세요."
          : reason === "changed"
            ? "다른 화면에서 분석 복구 정보가 변경되었습니다. 현재 접수 상태를 다시 확인해 주세요."
            : "분석 복구 정보의 형식이나 저장 한도를 확인할 수 없습니다. 현재 접수 상태를 다시 확인해 주세요.";
    });
    if (stored === null) {
      throw new UserFacingError(failureMessage);
    }
    checkpointRawValueRef.current = stored.rawValue;
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
    onAnalysisAccepted(acceptedRequestFromCheckpoint(restored), restored.url);
    if (clearPersistedCheckpoint()) {
      checkpointRef.current = null;
      setUrlInput("");
      setAcceptedMessage("접수된 분석은 사이드바에서 확인할 수 있습니다. 다음 주소를 입력해 주세요.");
    }
    // Consume mount-time recovery once; the dashboard owns ongoing requests.
  }, [readOnly, onAnalysisAccepted]);

  const handleReset = () => {
    cancelMutationOperation();
    setPhase("idle");
    setErrorMessage("");
    setIsSubmitting(false);
  };

  // The form and the progress view replace each other, so the focused control
  // is always unmounted on a phase change. Hand focus to the matching element
  // of the new view unless the user has already moved elsewhere.
  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (previousPhase === phase) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      const focusIsLost =
        !active || active === document.body || (panelRef.current?.contains(active) ?? false);
      if (!focusIsLost) {
        return;
      }
      const target =
        phase === "idle"
          ? urlInputRef.current
          : phase === "requesting"
            ? progressHeadingRef.current
            : (progressActionRef.current ?? progressHeadingRef.current);
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [phase]);

  // The attempt id doubles as the server's Idempotency-Key. If the POST
  // response is lost, later attempts look the request up by that key
  // instead of sending a second analysis.
  const startQuickAnalysis = async (
    normalized: string,
    signal: AbortSignal,
    isActiveOperation: () => boolean
  ): Promise<QuickAnalysisCheckpoint | null> => {
    const attemptId = createRandomUuid();
    const startedAt = Date.now();
    const postingAttempt: PersistedQuickAnalysisAttempt = {
      version: 1,
      attemptId,
      apiScope: API_BASE_URL,
      startedAt,
      url: normalized,
      phase: "posting",
      serverKey: true,
      knownRequestIds: []
    };
    persistCheckpoint(postingAttempt, null);

    const reconcilingCheckpoint: ReconcilingCheckpoint = {
      kind: "reconciling",
      serverKey: true,
      attemptId,
      startedAt,
      url: normalized,
      knownRequestIds: []
    };
    checkpointRef.current = reconcilingCheckpoint;
    let checkpoint: QuickAnalysisCheckpoint = reconcilingCheckpoint;

    try {
      const commitOutcome = await commitMutationOnce({
        signal,
        timeoutMessage: "분석을 시작하는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.",
        operation: (requestSignal) =>
          startUrlEvaluation(normalized, requestSignal, attemptId),
        accept: (created) =>
          requestCheckpointFromResponse(normalized, created, { attemptId, startedAt })
      });
      if (!isActiveOperation()) {
        return null;
      }

      if (commitOutcome.kind === "accepted") {
        persistCheckpoint(commitOutcome.value);
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

    if (checkpoint.kind === "reconciling") persistCheckpoint(checkpoint);
    return checkpoint;
  };

  const reconcileQuickAnalysis = async (
    reconcilingCheckpoint: ReconcilingCheckpoint,
    normalized: string,
    signal: AbortSignal,
    isActiveOperation: () => boolean
  ) => {
    const recoveredCheckpoint = await reconcileWithRetries({
      attempts: QUICK_ANALYSIS_RECONCILE_ATTEMPTS,
      intervalMs: QUICK_ANALYSIS_RECONCILE_INTERVAL_MS,
      signal,
      probe: async (requestSignal) => {
        if (reconcilingCheckpoint.serverKey) {
          const request = await runQuickAnalysisRequestWithTimeout({
            signal: requestSignal,
            timeoutMessage: "분석 접수 결과를 확인하는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.",
            operation: async probeSignal => await fetchAnalysisAttempt(reconcilingCheckpoint.attemptId, probeSignal)
              ?? await startUrlEvaluation(reconcilingCheckpoint.url, probeSignal, reconcilingCheckpoint.attemptId)
          });
          return isActiveOperation()
            ? requestCheckpointFromResponse(normalized, request, reconcilingCheckpoint) : null;
        }
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
    persistCheckpoint(recoveredCheckpoint);
    checkpointRef.current = recoveredCheckpoint;
    return recoveredCheckpoint;
  };

  const fetchReceiptTarget = async (
    checkpoint: QuickAnalysisReceipt,
    normalized: string,
    signal: AbortSignal,
    isActiveOperation: () => boolean
  ) => {
    const requestId = checkpoint.requestId;
    const request = await runQuickAnalysisRequestWithTimeout({
      signal,
      timeoutMessage: "분석 접수 정보를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.",
      operation: (requestSignal) => fetchEvaluationRequest(requestId, requestSignal)
    });
    if (!isActiveOperation()) return null;
    const recovered = requestCheckpointFromResponse(normalized, request, checkpoint);
    checkpointRef.current = recovered;
    persistCheckpoint(recovered);
    return recovered;
  };

  // Resolves to the accepted request's checkpoint, or null once the operation is no longer current.
  const resolveQuickAnalysisReceipt = async (
    current: QuickAnalysisCheckpoint | null,
    normalized: string,
    signal: AbortSignal,
    isActiveOperation: () => boolean
  ): Promise<QuickAnalysisReceipt | null> => {
    let checkpoint = current ?? await startQuickAnalysis(normalized, signal, isActiveOperation);
    if (checkpoint === null) {
      return null;
    }
    if (checkpoint.kind === "reconciling") {
      checkpoint = await reconcileQuickAnalysis(checkpoint, normalized, signal, isActiveOperation);
    }

    // A positive receipt releases this form. Status/result reads are owned by
    // the dashboard and cannot hold the next submission hostage.
    // Only a checkpoint saved by an earlier build can lack its page ID.
    if (checkpoint.targetId === null) {
      return fetchReceiptTarget(checkpoint, normalized, signal, isActiveOperation);
    }
    return checkpoint;
  };

  const reportQuickAnalysisFailure = (
    error: unknown,
    isActiveOperation: () => boolean,
    requiresInputReset: boolean
  ) => {
    if (!isActiveOperation() || isAbortError(error)) {
      return;
    }

    const message = getApiErrorMessage(error, "페이지 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    setErrorMessage(message);
    setPhase(requiresInputReset || checkpointRef.current === null ? "failed" : "paused");
  };

  const runQuickAnalysis = async (
    normalized: string,
    operation: MutationOperation,
    acceptAnalysis: AnalysisAcceptedHandler
  ) => {
    const { signal } = operation;
    const isActiveOperation = () => isMutationOperationCurrent(operation);

    setIsSubmitting(true);
    setErrorMessage("");
    setPhase("requesting");

    let requiresInputReset = false;

    try {
      const checkpoint = checkpointRef.current;
      if (checkpoint !== null && checkpoint.url !== normalized) {
        requiresInputReset = true;
        setUrlInput(checkpoint.url);
        throw new UserFacingError(QUICK_ANALYSIS_DIFFERENT_URL_MESSAGE);
      }

      const receipt = await resolveQuickAnalysisReceipt(checkpoint, normalized, signal, isActiveOperation);
      if (receipt === null) return;
      acceptAnalysis(acceptedRequestFromCheckpoint(receipt), normalized);
      if (!clearPersistedCheckpoint()) {
        throw new UserFacingError(QUICK_ANALYSIS_PERSISTENCE_FAILURE_MESSAGE);
      }
      checkpointRef.current = null;
      setUrlInput("");
      setPhase("idle");
      setAcceptedMessage("분석을 접수했습니다. 사이드바에서 진행 상태를 확인하고 다음 주소를 입력해 주세요.");
      window.requestAnimationFrame(() => urlInputRef.current?.focus());
    } catch (error) {
      reportQuickAnalysisFailure(error, isActiveOperation, requiresInputReset);
    } finally {
      if (finishMutationOperation(operation)) {
        setIsSubmitting(false);
      }
    }
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
    await runQuickAnalysis(normalized, operation, onAnalysisAccepted);
  };

  const liveAnnouncement = phase === "idle" ? acceptedMessage : QUICK_ANALYSIS_PHASE_ANNOUNCEMENTS[phase];

  return (
    <div className={`quick-analyze-layout min-h-0 w-full flex-1 ${showProgressView ? "quick-analyze-layout--progress" : "relative"}`}>
      {/* Stays mounted across the form/progress swap so changes are announced. */}
      <p className="sr-only" role="status" aria-atomic="true">{liveAnnouncement}</p>
      <article
        ref={panelRef}
        className={showProgressView ? "quick-analyze-progress-panel" : "absolute left-1/2 top-[40%] w-full max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-[28px] bg-transparent p-5 sm:max-w-2xl sm:p-7 lg:max-w-3xl lg:p-8"}
      >
        {!showProgressView ? (
          <QuickAnalyzeForm
            urlField={
              <QuickAnalyzeUrlField
                inputRef={urlInputRef}
                value={urlInput}
                hasError={hasError}
                isBusy={isBusy}
                readOnly={readOnly}
                onChange={(event) => {
                  setUrlInput(event.target.value);
                  if (errorMessage.length > 0) {
                    setErrorMessage("");
                  }
                }}
                onKeyDown={(event) => {
                  preventAccidentalSubmit(event);
                  if (event.defaultPrevented) return;
                  if (event.key === "Enter" && canSubmit) {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
            }
            canSubmit={canSubmit}
            isBusy={isBusy}
            readOnly={readOnly}
            acceptedMessage={acceptedMessage}
            errorMessage={errorMessage}
            hasError={hasError}
            onSubmit={handleSubmit}
          />
        ) : (
          <QuickAnalysisProgress
            phase={phase}
            url={normalizeUrl(urlInput)}
            isBusy={isBusy}
            headingRef={progressHeadingRef}
            announceStatus={false}
          >
            <QuickAnalysisRecoveryActions
              phase={phase}
              errorMessage={errorMessage}
              isSubmitting={isSubmitting}
              actionRef={progressActionRef}
              onReset={handleReset}
              onRetry={handleSubmit}
            />
          </QuickAnalysisProgress>
        )}
      </article>
    </div>
  );
}
