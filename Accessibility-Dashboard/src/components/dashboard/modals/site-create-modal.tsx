import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { throwIfAborted, wait } from "@/services/async-cancellation";
import { fetchEvaluationRequest, getApiErrorMessage, isAbortError } from "@/services/backend-api";
import {
  SITE_NAME_MAX_LENGTH,
  SITE_URL_MAX_LENGTH,
  clearSiteCreateRecovery,
  isValidEvaluationTargetAccessUrl,
  readSiteCreateRecovery,
  writeSiteCreateRecovery
} from "@/services/site-create-recovery-storage";
import type { PersistedSiteCreateAttempt } from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  CreateEvaluationTargetInput as CreateEvaluationTargetModelInput,
  EvaluationStatus,
  OrganizationModel
} from "@/types/accessibility-domain";

import {
  ANALYSIS_POLL_ATTEMPTS,
  getAnalysisPollDelayMs,
  runMutationRequestWithDeadline,
  waitForDocumentVisible
} from "../shared/mutation-recovery";
import {
  EVALUATION_REQUEST_FAILED_MESSAGE,
  evaluationRequestPhaseFromStatus,
  isFinalEvaluationRequestStatus
} from "../shared/evaluation-request-status";
import { useCancellationScope } from "../shared/use-cancellation-scope";
import { useDialogAccessibility } from "../shared/use-dialog-accessibility";
import { useExclusiveOperation } from "../shared/use-exclusive-operation";

const ANALYSIS_NETWORK_TIMEOUT_MESSAGE =
  "처리 결과를 확인하는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.";
const SITE_RECOVERY_PERSISTENCE_MESSAGE =
  "브라우저에 이전 작업 상태를 저장하지 못해 요청을 시작하지 않았습니다. 브라우저 저장 공간과 설정을 확인해 주세요.";
const SITE_RECOVERY_BLOCKED_MESSAGE =
  "확인할 수 없는 이전 페이지 작업이 남아 있어 중복 요청을 막았습니다. 이미 페이지가 추가되었는지 확인한 뒤 이전 작업 정보를 삭제해 주세요.";
const SITE_RECOVERY_STALE_MESSAGE =
  "오래된 페이지 작업 정보가 남아 있습니다. 목록에서 완료 여부를 확인한 뒤 이전 작업 정보를 삭제할 수 있습니다.";
const SITE_RECOVERY_CONFLICT_MESSAGE =
  "다른 프로젝트에서 완료 여부를 확인하지 못한 페이지 작업이 남아 있어 새 요청을 시작하지 않았습니다. 해당 프로젝트에서 작업을 이어가거나 로그아웃한 뒤 다시 시도해 주세요.";
const TARGET_RECOVERY_MESSAGE =
  "이전 페이지 등록 결과를 확인하고 있습니다. 중복 등록을 막기 위해 새 요청은 보내지 않습니다.";
const REQUEST_READY_MESSAGE =
  "페이지 등록이 완료되었습니다. 준비가 되면 분석을 시작해 주세요.";
const REQUEST_RECONCILING_MESSAGE =
  "이전 분석 요청이 시작되었는지 확인이 필요합니다. 중복 분석을 막기 위해 새 요청은 보내지 않습니다.";
const REQUEST_STATUS_RECOVERY_MESSAGE =
  "기존 분석 요청의 상태를 다시 확인할 수 있습니다. 새 분석 요청은 보내지 않습니다.";

async function runWithAnalysisNetworkDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal
): Promise<T> {
  return runMutationRequestWithDeadline({
    operation,
    signal: callerSignal,
    timeoutMessage: ANALYSIS_NETWORK_TIMEOUT_MESSAGE
  });
}

type AnalysisProgressPhase =
  | "idle"
  | "creating"
  | "requesting"
  | "queued"
  | "running"
  | "saving"
  | "completed"
  | "ready"
  | "paused"
  | "failed";

type AnalysisProgress = {
  phase: AnalysisProgressPhase;
  requestId: number | null;
  status: EvaluationStatus | string | null;
  message: string;
};

type AnalysisResumePoint =
  | { kind: "create" }
  | { kind: "request"; targetId: number; previousFailedRequestId?: number }
  | { kind: "poll"; targetId: number; requestId: number };

const initialResumePoint: AnalysisResumePoint = { kind: "create" };

const emptyProgress: AnalysisProgress = {
  phase: "idle",
  requestId: null,
  status: null,
  message: ""
};

function resumePointFromPersistedAttempt(
  attempt: PersistedSiteCreateAttempt
): AnalysisResumePoint {
  if (attempt.phase === "target-reconciling") {
    return initialResumePoint;
  }
  if (attempt.phase === "request-ready") {
    return {
      kind: "request",
      targetId: attempt.targetId,
      ...(attempt.previousFailedRequestId !== null
        ? { previousFailedRequestId: attempt.previousFailedRequestId }
        : {})
    };
  }
  if (attempt.phase === "request-reconciling") {
    return {
      kind: "request",
      targetId: attempt.targetId,
      ...(attempt.previousFailedRequestId !== null
        ? { previousFailedRequestId: attempt.previousFailedRequestId }
        : {})
    };
  }
  return {
    kind: "poll",
    targetId: attempt.targetId,
    requestId: attempt.requestId
  };
}

function progressFromPersistedAttempt(
  attempt: PersistedSiteCreateAttempt
): AnalysisProgress {
  if (attempt.phase === "target-reconciling") {
    return emptyProgress;
  }
  if (attempt.phase === "request-ready") {
    if (attempt.previousFailedRequestId !== null) {
      return {
        phase: "failed",
        requestId: attempt.previousFailedRequestId,
        status: "FAILED",
        message: EVALUATION_REQUEST_FAILED_MESSAGE
      };
    }
    return {
      phase: "ready",
      requestId: null,
      status: null,
      message: REQUEST_READY_MESSAGE
    };
  }
  if (attempt.phase === "request-reconciling") {
    return {
      phase: "paused",
      requestId: null,
      status: null,
      message: REQUEST_RECONCILING_MESSAGE
    };
  }
  if (attempt.phase === "poll") {
    return {
      phase: "paused",
      requestId: attempt.requestId,
      status: null,
      message: REQUEST_STATUS_RECOVERY_MESSAGE
    };
  }
  return emptyProgress;
}

function messageFromPersistedAttempt(attempt: PersistedSiteCreateAttempt): string {
  if (attempt.phase === "target-reconciling") {
    return TARGET_RECOVERY_MESSAGE;
  }
  if (attempt.phase === "request-ready") {
    return attempt.previousFailedRequestId === null
      ? REQUEST_READY_MESSAGE
      : EVALUATION_REQUEST_FAILED_MESSAGE;
  }
  if (attempt.phase === "request-reconciling") {
    return REQUEST_RECONCILING_MESSAGE;
  }
  return REQUEST_STATUS_RECOVERY_MESSAGE;
}

const progressSteps = [
  { key: "creating", label: "페이지 등록", description: "프로젝트에 분석 대상을 추가합니다." },
  { key: "requesting", label: "분석 요청", description: "페이지 분석을 요청합니다." },
  { key: "running", label: "페이지 검사", description: "규칙, 텍스트 난이도, 시각 요소를 검사합니다." },
  { key: "saving", label: "결과 저장", description: "분석 결과와 점수를 반영합니다." },
  { key: "completed", label: "완료", description: "대시보드에 최신 결과를 표시합니다." }
] as const;

function phaseFromRequestStatus(status: EvaluationStatus | string): AnalysisProgressPhase {
  const phase = evaluationRequestPhaseFromStatus(status);
  if (phase === "completed") {
    return "saving";
  }
  return phase;
}

function messageFromRequestStatus(status: EvaluationStatus | string): string {
  if (status === "PENDING") {
    return "분석 요청이 대기열에 등록되었습니다.";
  }

  if (status === "COMPLETED") {
    return "분석이 완료되어 결과를 저장하고 있습니다.";
  }

  if (status === "FAILED") {
    return EVALUATION_REQUEST_FAILED_MESSAGE;
  }

  return "페이지 접근성 검사를 진행하고 있습니다.";
}

function getActiveStepIndex(progress: AnalysisProgress, resumePoint: AnalysisResumePoint) {
  const { phase } = progress;
  if (phase === "idle") {
    return -1;
  }

  if (phase === "failed") {
    if (progress.status === "FAILED") {
      return 2;
    }
    if (resumePoint.kind === "create") {
      return 0;
    }
    if (resumePoint.kind === "request") {
      return 1;
    }
    return progress.status === "COMPLETED" ? 3 : 2;
  }

  if (phase === "paused") {
    if (progress.status === "COMPLETED") {
      return 3;
    }
    return resumePoint.kind === "request" ? 1 : 2;
  }

  if (phase === "ready") {
    return 1;
  }

  if (phase === "creating") {
    return 0;
  }

  if (phase === "requesting" || phase === "queued") {
    return 1;
  }

  if (phase === "running") {
    return 2;
  }

  if (phase === "saving") {
    return 3;
  }

  return 4;
}

export function SiteCreateModal({
  isOpen,
  isDarkMode,
  project,
  onCreateEvaluationTargetModel,
  onRequestEvaluationTargetAnalysis,
  onAnalysisComplete,
  onClose
}: {
  isOpen: boolean;
  isDarkMode: boolean;
  project: OrganizationModel;
  onCreateEvaluationTargetModel: (
    input: CreateEvaluationTargetModelInput,
    signal?: AbortSignal
  ) => Promise<number>;
  onRequestEvaluationTargetAnalysis: (
    targetId: number,
    signal?: AbortSignal,
    previousFailedRequestId?: number
  ) => Promise<number>;
  onAnalysisComplete?: (signal?: AbortSignal) => Promise<unknown>;
  onClose: () => void;
}) {
  const [siteName, setSiteName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isSubmittingSite, setIsSubmittingSite] = useState(false);
  const [siteCreateError, setSiteCreateError] = useState("");
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress>(emptyProgress);
  const [resumePoint, setResumePoint] = useState<AnalysisResumePoint>(initialResumePoint);
  const [isRecoveryBlocked, setIsRecoveryBlocked] = useState(false);
  const [canDiscardRecovery, setCanDiscardRecovery] = useState(false);
  const { beginScope, cancelScope } = useCancellationScope();
  const {
    beginOperation,
    cancelOperation,
    finishOperation,
    isOperationCurrent,
    isOperationLocked
  } = useExclusiveOperation();
  const autoCloseTimeoutRef = useRef<number | null>(null);
  const recoveryRawValueRef = useRef<string | null>(null);
  const discardLockRef = useRef(false);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useDialogAccessibility({
    isOpen,
    onClose,
    closeDisabled: isSubmittingSite
  });
  const hasAnalysisProgress = analysisProgress.phase !== "idle";
  const isRetryableProgress =
    analysisProgress.phase === "ready" ||
    analysisProgress.phase === "paused" ||
    analysisProgress.phase === "failed";
  const showFooter = !hasAnalysisProgress || isRetryableProgress;
  const isAnalysisNotice =
    analysisProgress.phase === "ready" || analysisProgress.phase === "paused";

  useLayoutEffect(() => {
    if (isOpen && siteCreateError.length > 0) {
      scrollRegionRef.current?.scrollTo({ top: 0 });
    }
  }, [isOpen, siteCreateError]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const recovery = readSiteCreateRecovery();
    if (recovery.kind === "blocked") {
      recoveryRawValueRef.current = recovery.rawValue;
      setIsRecoveryBlocked(true);
      setCanDiscardRecovery(recovery.rawValue !== null);
      setResumePoint(initialResumePoint);
      setAnalysisProgress(emptyProgress);
      setSiteName("");
      setBaseUrl("");
      setSiteCreateError(SITE_RECOVERY_BLOCKED_MESSAGE);
      return;
    }

    if (recovery.kind === "valid" && recovery.attempt.projectId === project.id) {
      const restoredResumePoint = resumePointFromPersistedAttempt(recovery.attempt);
      recoveryRawValueRef.current = recovery.rawValue;
      setIsRecoveryBlocked(false);
      setCanDiscardRecovery(recovery.isStale);
      setSiteName(recovery.attempt.name);
      setBaseUrl(recovery.attempt.accessUrl);
      setResumePoint(restoredResumePoint);
      setAnalysisProgress(progressFromPersistedAttempt(recovery.attempt));
      setSiteCreateError(
        recovery.isStale
          ? SITE_RECOVERY_STALE_MESSAGE
          : messageFromPersistedAttempt(recovery.attempt)
      );
      return;
    }

    if (recovery.kind === "valid") {
      recoveryRawValueRef.current = recovery.rawValue;
      setIsRecoveryBlocked(true);
      setCanDiscardRecovery(recovery.isStale);
      setResumePoint(initialResumePoint);
      setAnalysisProgress(emptyProgress);
      setSiteName("");
      setBaseUrl("");
      setSiteCreateError(
        recovery.isStale ? SITE_RECOVERY_STALE_MESSAGE : SITE_RECOVERY_CONFLICT_MESSAGE
      );
      return;
    }

    recoveryRawValueRef.current = null;
    setIsRecoveryBlocked(false);
    setCanDiscardRecovery(false);
    setResumePoint(initialResumePoint);
    setAnalysisProgress(emptyProgress);
    setSiteName("");
    setBaseUrl("");
    setSiteCreateError("");
  }, [isOpen, project.id]);

  useEffect(() => {
    if (!isOpen) {
      // Closing the modal must stop the analysis polling loop as well, otherwise
      // it keeps hitting the backend until the 120 attempts run out.
      cancelScope();
      cancelOperation();
      discardLockRef.current = false;
      if (autoCloseTimeoutRef.current !== null) {
        window.clearTimeout(autoCloseTimeoutRef.current);
        autoCloseTimeoutRef.current = null;
      }
      setIsSubmittingSite(false);
      if (resumePoint.kind === "create") {
        setSiteName("");
        setBaseUrl("");
        setSiteCreateError("");
        setAnalysisProgress(emptyProgress);
      }
    }
  }, [cancelOperation, cancelScope, isOpen, resumePoint.kind]);

  useEffect(
    () => {
      return () => {
        if (autoCloseTimeoutRef.current !== null) {
          window.clearTimeout(autoCloseTimeoutRef.current);
          autoCloseTimeoutRef.current = null;
        }
      };
    },
    []
  );

  const handleDiscardRecovery = () => {
    if (
      discardLockRef.current ||
      isOperationLocked() ||
      (!isRecoveryBlocked && !canDiscardRecovery)
    ) {
      return;
    }
    const rawValue = recoveryRawValueRef.current;
    if (rawValue === null) {
      setSiteCreateError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      return;
    }
    if (
      !window.confirm(
        "페이지나 분석이 이미 시작되지 않았는지 목록에서 확인하셨나요? 이전 작업 정보를 삭제하면 같은 요청이 다시 전송될 수 있습니다."
      )
    ) {
      return;
    }

    discardLockRef.current = true;
    if (!clearSiteCreateRecovery(rawValue)) {
      discardLockRef.current = false;
      setSiteCreateError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      return;
    }

    recoveryRawValueRef.current = null;
    setIsRecoveryBlocked(false);
    setCanDiscardRecovery(false);
    setResumePoint(initialResumePoint);
    setAnalysisProgress(emptyProgress);
    setSiteName("");
    setBaseUrl("");
    setSiteCreateError("");
    discardLockRef.current = false;
  };

  const handleAddSite = async () => {
    if (isOperationLocked()) {
      return;
    }
    if (isRecoveryBlocked) {
      setSiteCreateError(SITE_RECOVERY_BLOCKED_MESSAGE);
      return;
    }

    const name = siteName.trim();
    const accessUrl = baseUrl.trim();

    if (resumePoint.kind === "create" && (name.length === 0 || accessUrl.length === 0)) {
      setSiteCreateError("페이지 이름과 주소를 입력해주세요.");
      return;
    }
    if (resumePoint.kind === "create" && name.length > SITE_NAME_MAX_LENGTH) {
      setSiteCreateError(`페이지 이름은 ${SITE_NAME_MAX_LENGTH}자 이하로 입력해주세요.`);
      return;
    }
    if (resumePoint.kind === "create" && !isValidEvaluationTargetAccessUrl(accessUrl)) {
      setSiteCreateError("올바른 페이지 주소를 입력해주세요. 예: https://example.com");
      return;
    }

    const operationId = beginOperation("site-create-operation");
    if (operationId === null) {
      return;
    }
    const isActiveOperation = () => isOperationCurrent(operationId);
    let keepLockedUntilAutoClose = false;

    // Aborts when the modal closes or unmounts.
    const signal = beginScope();

    setIsSubmittingSite(true);
    setSiteCreateError("");
    setAnalysisProgress({
      phase: resumePoint.kind === "create" ? "creating" : "requesting",
      requestId: null,
      status: null,
      message:
        resumePoint.kind === "create"
          ? "페이지를 프로젝트에 추가하고 있습니다."
          : "등록된 페이지의 분석을 다시 시작하고 있습니다."
    });

    let nextResumePoint = resumePoint;
    let terminalRequestFailed = false;

    try {
      let targetId: number;
      if (nextResumePoint.kind === "create") {
        targetId = await onCreateEvaluationTargetModel(
          {
            projectId: project.id,
            name,
            accessUrl
          },
          signal
        );
        if (!isActiveOperation()) {
          return;
        }
        throwIfAborted(signal);
        nextResumePoint = { kind: "request", targetId };
        setResumePoint(nextResumePoint);
      } else {
        targetId = nextResumePoint.targetId;
      }

      let requestId: number;
      if (nextResumePoint.kind === "poll") {
        requestId = nextResumePoint.requestId;
        setAnalysisProgress({
          phase: "running",
          requestId,
          status: analysisProgress.status,
          message: "기존 분석 요청의 상태를 다시 확인하고 있습니다."
        });
      } else {
        setAnalysisProgress({
          phase: "requesting",
          requestId: null,
          status: "PENDING",
          message: "등록된 페이지에 분석 요청을 생성하고 있습니다."
        });
        requestId = await onRequestEvaluationTargetAnalysis(
          targetId,
          signal,
          nextResumePoint.kind === "request"
            ? nextResumePoint.previousFailedRequestId
            : undefined
        );
        if (!isActiveOperation()) {
          return;
        }
        throwIfAborted(signal);
        nextResumePoint = { kind: "poll", targetId, requestId };
        setResumePoint(nextResumePoint);
        setAnalysisProgress({
          phase: "requesting",
          requestId,
          status: "PENDING",
          message: "분석 요청을 생성했습니다."
        });
      }

      let finalStatus: string | null = null;
      for (let attempt = 0; attempt < ANALYSIS_POLL_ATTEMPTS; attempt += 1) {
        await waitForDocumentVisible(signal);
        if (attempt > 0) {
          await wait(getAnalysisPollDelayMs(attempt), signal);
          await waitForDocumentVisible(signal);
        }

        const request = await runWithAnalysisNetworkDeadline(
          (requestSignal) => fetchEvaluationRequest(requestId, requestSignal),
          signal
        );
        if (!isActiveOperation()) {
          return;
        }
        throwIfAborted(signal);
        finalStatus = request.status;
        setAnalysisProgress({
          phase: phaseFromRequestStatus(request.status),
          requestId,
          status: request.status,
          message: messageFromRequestStatus(request.status)
        });

        if (isFinalEvaluationRequestStatus(request.status)) {
          break;
        }
      }

      if (finalStatus === "FAILED") {
        terminalRequestFailed = true;
        nextResumePoint = {
          kind: "request",
          targetId,
          previousFailedRequestId: requestId
        };
        setResumePoint(nextResumePoint);
        const recovery = readSiteCreateRecovery();
        if (
          recovery.kind !== "valid" ||
          recovery.attempt.phase !== "poll" ||
          recovery.attempt.targetId !== targetId ||
          recovery.attempt.requestId !== requestId ||
          writeSiteCreateRecovery(
            {
              ...recovery.attempt,
              phase: "request-ready",
              targetId,
              previousFailedRequestId: requestId
            },
            recovery.rawValue
          ) === null
        ) {
          throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        throw new UserFacingError(EVALUATION_REQUEST_FAILED_MESSAGE);
      }

      if (!isFinalEvaluationRequestStatus(finalStatus)) {
        throw new UserFacingError(
          "분석 진행 상태를 확인하는 데 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요."
        );
      }

      setAnalysisProgress({
        phase: "saving",
        requestId,
        status: "COMPLETED",
        message: "최신 결과를 대시보드에 반영하고 있습니다."
      });
      if (onAnalysisComplete) {
        await runWithAnalysisNetworkDeadline(
          (requestSignal) => onAnalysisComplete(requestSignal),
          signal
        );
      }

      if (!isActiveOperation()) {
        return;
      }
      throwIfAborted(signal);

      const completedRecovery = readSiteCreateRecovery();
      if (
        completedRecovery.kind === "blocked" ||
        (completedRecovery.kind === "valid" &&
          (completedRecovery.attempt.phase !== "poll" ||
            completedRecovery.attempt.targetId !== targetId ||
            completedRecovery.attempt.requestId !== requestId ||
            !clearSiteCreateRecovery(completedRecovery.rawValue)))
      ) {
        throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }

      setAnalysisProgress({
        phase: "completed",
        requestId,
        status: "COMPLETED",
        message: "분석이 완료되었습니다."
      });
      setResumePoint(initialResumePoint);
      setSiteName("");
      setBaseUrl("");

      keepLockedUntilAutoClose = true;
      autoCloseTimeoutRef.current = window.setTimeout(() => {
        autoCloseTimeoutRef.current = null;
        if (finishOperation(operationId)) {
          setIsSubmittingSite(false);
          onClose();
        }
      }, 900);
    } catch (error) {
      if (isAbortError(error) || !isActiveOperation()) {
        return;
      }

      setResumePoint(nextResumePoint);
      const message = getApiErrorMessage(
        error,
        nextResumePoint.kind === "create"
          ? "페이지를 추가하지 못했습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요."
          : "페이지는 등록되었지만 분석을 시작하지 못했습니다. 분석만 다시 시도해 주세요."
      );
      setSiteCreateError(message);
      if (nextResumePoint.kind === "create") {
        const unresolvedRecovery = readSiteCreateRecovery();
        if (
          unresolvedRecovery.kind === "valid" &&
          unresolvedRecovery.attempt.projectId === project.id
        ) {
          recoveryRawValueRef.current = unresolvedRecovery.rawValue;
          setCanDiscardRecovery(true);
        }
        setAnalysisProgress(emptyProgress);
      } else {
        const persistedRecovery = readSiteCreateRecovery();
        const persistedAttempt =
          persistedRecovery.kind === "valid" &&
          persistedRecovery.attempt.projectId === project.id
            ? persistedRecovery.attempt
            : null;
        const recoveryPhase: AnalysisProgressPhase = terminalRequestFailed
          ? "failed"
          : persistedAttempt?.phase === "request-reconciling" ||
              persistedAttempt?.phase === "poll" ||
              nextResumePoint.kind === "poll"
            ? "paused"
            : persistedAttempt?.phase === "request-ready" &&
                persistedAttempt.previousFailedRequestId === null
              ? "ready"
              : "failed";
        setAnalysisProgress((current) => ({
          ...current,
          phase: recoveryPhase,
          message
        }));
      }
    } finally {
      // The request-recovery hook binds its in-memory directory lease to this
      // operation scope. Ending the scope releases that lease while the
      // persisted checkpoint remains available for a deliberate retry.
      cancelScope();
      if (!keepLockedUntilAutoClose && finishOperation(operationId)) {
        setIsSubmittingSite(false);
      }
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dashboard-modal-layer fixed inset-0 flex items-center justify-center bg-black/60 px-4 py-6">
      <div
        className="absolute inset-0"
        aria-hidden="true"
        onClick={() => {
          if (!isSubmittingSite) {
            onClose();
          }
        }}
      />

      <article
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-create-title"
        tabIndex={-1}
        className={`relative z-10 flex max-h-[calc(100dvh-3rem)] w-full max-w-md flex-col overflow-hidden rounded-[18px] border ${
          isDarkMode ? "border-[#3a3a3c] bg-[#1c1c1e]" : "border-[#d2d2d7] bg-white"
        }`}
      >
        <header className="shrink-0 px-6 pb-4 pt-6">
          <h2
            id="site-create-title"
            className={`text-lg font-semibold tracking-[-0.015em] ${
              isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"
            }`}
          >
            페이지 추가
          </h2>
        </header>

        <div
          ref={scrollRegionRef}
          data-site-create-scroll-region
          role="region"
          aria-label="페이지 추가 내용"
          tabIndex={0}
          className={`site-create-modal-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 ${
            showFooter ? "" : "pb-6"
          }`}
        >
          {siteCreateError.length > 0 && (
            <div
              role="alert"
              className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
                isAnalysisNotice
                  ? isDarkMode
                    ? "border-[#5b4a1f] bg-[#2a2519] text-[#ffd60a]"
                    : "border-amber-200 bg-amber-50 text-amber-800"
                  : isDarkMode
                    ? "border-[#5e2b32] bg-[#2d1d20] text-[#ff9aa8]"
                    : "border-rose-200 bg-rose-50 text-rose-700"
              }`}
            >
              {resumePoint.kind === "create"
                ? "페이지 추가 실패"
                : analysisProgress.phase === "ready"
                  ? "페이지 등록 완료 · 분석 시작 전"
                  : analysisProgress.phase === "paused"
                  ? "페이지 등록 완료 · 상태 확인 필요"
                  : "페이지 등록 완료 · 분석 실패"}: {siteCreateError}
            </div>
          )}

          {hasAnalysisProgress ? (
            <AnalysisProgressPanel
              progress={analysisProgress}
              resumePoint={resumePoint}
              isDarkMode={isDarkMode}
              showMessage={siteCreateError.length === 0}
            />
          ) : (
            <div className="grid gap-3.5">
              <label className="block">
                <span
                  className={`mb-1.5 block text-xs font-semibold ${
                    isDarkMode ? "text-[#d1d1d6]" : "text-[#3a3a3c]"
                  }`}
                >
                  페이지 이름
                </span>
                <Input
                  value={siteName}
                  onChange={(event) => setSiteName(event.target.value)}
                  disabled={isRecoveryBlocked}
                  maxLength={SITE_NAME_MAX_LENGTH}
                  placeholder="페이지 이름 입력"
                  className={
                    isDarkMode
                      ? "border-[#3a3a3c] bg-[#242426] text-[#f5f5f7] placeholder:text-[#8e8e93] focus-visible:border-white focus-visible:ring-0"
                      : "border-[#d2d2d7] bg-white text-[#1d1d1f] placeholder:text-[#86868b] focus-visible:border-[#1d1d1f] focus-visible:ring-0"
                  }
                />
              </label>

              <label className="block">
                <span
                  className={`mb-1.5 block text-xs font-semibold ${
                    isDarkMode ? "text-[#d1d1d6]" : "text-[#3a3a3c]"
                  }`}
                >
                  페이지 주소
                </span>
                <Input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  disabled={isRecoveryBlocked}
                  maxLength={SITE_URL_MAX_LENGTH}
                  placeholder="https://example.com"
                  className={
                    isDarkMode
                      ? "border-[#3a3a3c] bg-[#242426] text-[#f5f5f7] placeholder:text-[#8e8e93] focus-visible:border-white focus-visible:ring-0"
                      : "border-[#d2d2d7] bg-white text-[#1d1d1f] placeholder:text-[#86868b] focus-visible:border-[#1d1d1f] focus-visible:ring-0"
                  }
                />
              </label>
            </div>
          )}
        </div>

        {showFooter && (
          <div
            data-site-create-footer
            className="flex shrink-0 flex-col items-stretch gap-3 px-6 pb-6 pt-5 sm:flex-row sm:items-center sm:justify-between"
          >
            {hasAnalysisProgress ? (
              <p
                className={`min-w-0 flex-1 text-xs font-medium ${
                  isDarkMode ? "text-[#8e8e93]" : "text-[#86868b]"
                }`}
              >
                {resumePoint.kind === "create"
                  ? "입력 내용을 유지한 채 다시 시도할 수 있습니다."
                  : "페이지는 등록되어 있으며 분석 단계만 다시 시도합니다."}
              </p>
            ) : (
              <span />
            )}
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0">
              {(isRecoveryBlocked || canDiscardRecovery) && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={isSubmittingSite || !canDiscardRecovery}
                  onClick={handleDiscardRecovery}
                  className="h-7 px-3 text-xs font-semibold"
                >
                  이전 작업 정보 삭제
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isSubmittingSite}
                onClick={onClose}
                className={
                  isDarkMode
                    ? "h-7 bg-[#2c2c2e] px-5 text-xs text-[#f5f5f7] hover:bg-[#3a3a3c]"
                    : "h-7 bg-[#e5e5ea] px-5 text-xs text-[#1d1d1f] hover:bg-[#d2d2d7]"
                }
              >
                {isRetryableProgress && resumePoint.kind !== "create" ? "닫기" : "취소"}
              </Button>

              {!hasAnalysisProgress && (
                <Button
                  type="button"
                  size="sm"
                  disabled={isSubmittingSite || isRecoveryBlocked}
                  onClick={() => {
                    void handleAddSite();
                  }}
                  className="h-7 bg-[#0071e3] px-5 text-xs font-semibold text-white hover:bg-[#0066cc]"
                >
                  분석 시작
                </Button>
              )}

              {isRetryableProgress && (
                <Button
                  type="button"
                  size="sm"
                  disabled={isSubmittingSite || isRecoveryBlocked}
                  onClick={() => {
                    void handleAddSite();
                  }}
                  className="h-7 bg-[#0071e3] px-5 text-xs font-semibold text-white hover:bg-[#0066cc]"
                >
                  {analysisProgress.phase === "ready"
                    ? "분석 시작"
                    : analysisProgress.phase === "paused" && resumePoint.kind === "request"
                      ? "분석 시작 여부 확인"
                      : resumePoint.kind === "create"
                        ? "다시 시도"
                        : resumePoint.kind === "request"
                          ? "분석 요청 다시 시도"
                          : "상태 확인 다시 시도"}
                </Button>
              )}
            </div>
          </div>
        )}
      </article>
    </div>
  );
}

function AnalysisProgressPanel({
  progress,
  resumePoint,
  isDarkMode,
  showMessage
}: {
  progress: AnalysisProgress;
  resumePoint: AnalysisResumePoint;
  isDarkMode: boolean;
  showMessage: boolean;
}) {
  const activeStepIndex = getActiveStepIndex(progress, resumePoint);

  return (
    <section
      aria-live="polite"
      className={`rounded-xl border px-4 py-4 ${
        isDarkMode ? "border-[#3a3a3c] bg-[#242426]" : "border-[#d2d2d7] bg-[#f5f5f7]"
      }`}
    >
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"}`}>
            {progress.phase === "failed"
              ? "분석을 완료하지 못했습니다"
              : progress.phase === "ready"
                ? "분석을 시작할 수 있습니다"
              : progress.phase === "paused"
                ? "분석 상태를 다시 확인해 주세요"
                : "분석 진행 중"}
          </p>
          {showMessage && (
            <p className={`mt-1 text-xs ${isDarkMode ? "text-[#a1a1a6]" : "text-[#68686d]"}`}>
              {progress.message}
            </p>
          )}
        </div>
        {progress.requestId !== null && (
          <span
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
              isDarkMode ? "bg-[#2c2c2e] text-[#d1d1d6]" : "bg-white text-[#68686d]"
            }`}
          >
            요청 #{progress.requestId}
          </span>
        )}
      </div>

      <ol className="mt-5 grid gap-3">
        {progressSteps.map((step, index) => {
          const isCompleted = progress.phase === "completed" || index < activeStepIndex;
          const isActive =
            index === activeStepIndex &&
            progress.phase !== "completed" &&
            progress.phase !== "ready" &&
            progress.phase !== "paused" &&
            progress.phase !== "failed";
          const isFailed = progress.phase === "failed" && index === activeStepIndex;

          return (
            <li
              key={step.key}
              className={`flex items-start gap-3 rounded-lg px-3 py-3 ${
                isDarkMode ? "bg-[#1c1c1e]" : "bg-white"
              }`}
            >
              <span
                className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  isCompleted
                    ? "bg-emerald-50 text-emerald-600"
                    : isFailed
                      ? "bg-rose-50 text-rose-600"
                      : isActive
                        ? "bg-[#0071e3]/15 text-[#2997ff]"
                        : isDarkMode
                          ? "bg-[#2c2c2e] text-[#636366]"
                          : "bg-[#e5e5ea] text-[#8e8e93]"
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 size={16} />
                ) : isFailed ? (
                  <XCircle size={16} />
                ) : isActive ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Circle size={14} />
                )}
              </span>
              <span className="min-w-0">
                <span className={`block text-sm font-semibold ${isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"}`}>
                  {step.label}
                </span>
                <span className={`mt-0.5 block text-xs leading-5 ${isDarkMode ? "text-[#8e8e93]" : "text-[#86868b]"}`}>
                  {step.description}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
