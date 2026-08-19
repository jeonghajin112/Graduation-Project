import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { throwIfAborted, wait } from "@/services/async-cancellation";
import { fetchEvaluationRequest, getApiErrorMessage, isAbortError } from "@/services/backend-api";
import {
  clearSiteCreateRecovery,
  readSiteCreateRecovery,
  writeSiteCreateRecovery
} from "@/services/site-create-recovery-storage";
import type { PersistedSiteCreateAttempt } from "@/services/site-create-recovery-storage";
import type {
  CreateEvaluationTargetInput as CreateEvaluationTargetModelInput,
  EvaluationStatus,
  OrganizationModel
} from "@/types/accessibility-domain";

import { useCancellationScope } from "../shared/use-cancellation-scope";
import { useDialogAccessibility } from "../shared/use-dialog-accessibility";

const ANALYSIS_POLL_INTERVAL_MS = 1500;
const ANALYSIS_POLL_ATTEMPTS = 120;
const ANALYSIS_NETWORK_TIMEOUT_MS = 15_000;
const ANALYSIS_NETWORK_TIMEOUT_MESSAGE = "서버 응답 대기 시간이 초과되었습니다.";
const SITE_RECOVERY_PERSISTENCE_MESSAGE =
  "브라우저에 안전한 복구 정보를 저장하지 못했습니다. 저장 공간 또는 브라우저 설정을 확인해 주세요.";
const SITE_RECOVERY_BLOCKED_MESSAGE =
  "이전 버전, 다른 서버 또는 손상된 페이지 생성 복구 정보가 남아 있어 새 요청을 잠갔습니다. 서버 상태를 확인한 뒤 복구 정보를 삭제해 주세요.";
const SITE_RECOVERY_STALE_MESSAGE =
  "24시간이 지난 복구 정보입니다. 서버 상태를 먼저 확인한 뒤 목록만 다시 확인하거나 복구 정보를 삭제할 수 있습니다.";
const SITE_RECOVERY_CONFLICT_MESSAGE =
  "다른 프로젝트의 완료 여부를 확인하지 못한 페이지 작업이 남아 있어 새 요청을 잠갔습니다. 기존 프로젝트에서 복구를 이어가거나, 24시간이 지난 뒤 복구 정보를 삭제하거나, 로그아웃해 주세요.";
const TARGET_RECOVERY_MESSAGE =
  "이전 페이지 생성 결과를 목록에서 다시 확인합니다. 중복 방지를 위해 생성 요청은 다시 보내지 않습니다.";
const REQUEST_RECOVERY_MESSAGE =
  "이전 분석 요청 결과를 목록에서 다시 확인합니다. 중복 방지를 위해 분석 요청은 다시 보내지 않습니다.";

async function runWithAnalysisNetworkDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal
): Promise<T> {
  throwIfAborted(callerSignal);
  const controller = new AbortController();
  let didTimeout = false;
  const forwardCallerAbort = () => controller.abort();
  callerSignal.addEventListener("abort", forwardCallerAbort, { once: true });
  const timeoutId = window.setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, ANALYSIS_NETWORK_TIMEOUT_MS);

  try {
    const value = await operation(controller.signal);
    throwIfAborted(callerSignal);
    if (didTimeout) {
      throw new Error(ANALYSIS_NETWORK_TIMEOUT_MESSAGE);
    }
    return value;
  } catch (error) {
    throwIfAborted(callerSignal);
    if (didTimeout) {
      throw new Error(ANALYSIS_NETWORK_TIMEOUT_MESSAGE);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal.removeEventListener("abort", forwardCallerAbort);
  }
}

type AnalysisProgressPhase = "idle" | "creating" | "requesting" | "queued" | "running" | "saving" | "completed" | "failed";

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
  if (attempt.phase === "poll") {
    return {
      phase: "failed",
      requestId: attempt.requestId,
      status: null,
      message: "기존 분석 요청의 상태 확인을 이어서 진행할 수 있습니다."
    };
  }
  return {
    phase: "failed",
    requestId: null,
    status: null,
    message: REQUEST_RECOVERY_MESSAGE
  };
}

const progressSteps = [
  { key: "creating", label: "페이지 등록", description: "프로젝트에 분석 대상을 추가합니다." },
  { key: "requesting", label: "분석 요청", description: "백엔드에 분석 작업을 생성합니다." },
  { key: "running", label: "분석 엔진 실행", description: "규칙, 텍스트 난이도, CV 분석을 실행합니다." },
  { key: "saving", label: "결과 저장", description: "분석 결과와 점수를 반영합니다." },
  { key: "completed", label: "완료", description: "대시보드에 최신 결과를 표시합니다." }
] as const;

function isFinalRequestStatus(status: string | null) {
  return status === "COMPLETED" || status === "FAILED";
}

function phaseFromRequestStatus(status: EvaluationStatus | string): AnalysisProgressPhase {
  if (status === "PENDING") {
    return "queued";
  }

  if (status === "COMPLETED") {
    return "saving";
  }

  if (status === "FAILED") {
    return "failed";
  }

  return "running";
}

function messageFromRequestStatus(status: EvaluationStatus | string): string {
  if (status === "PENDING") {
    return "분석 요청이 대기열에 등록되었습니다.";
  }

  if (status === "COMPLETED") {
    return "분석이 완료되어 결과를 저장하고 있습니다.";
  }

  if (status === "FAILED") {
    return "분석 엔진이 실패했습니다. 대상 사이트 접속 차단 또는 리다이렉트가 원인일 수 있습니다.";
  }

  return "분석 엔진이 접근성 검사를 수행하고 있습니다.";
}

function getActiveStepIndex(progress: AnalysisProgress, resumePoint: AnalysisResumePoint) {
  const { phase } = progress;
  if (phase === "idle") {
    return -1;
  }

  if (phase === "failed") {
    if (resumePoint.kind === "create") {
      return 0;
    }
    if (resumePoint.kind === "request") {
      return 1;
    }
    return progress.status === "COMPLETED" ? 3 : 2;
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
  const autoCloseTimeoutRef = useRef<number | null>(null);
  const submissionLockRef = useRef(false);
  const activeOperationIdRef = useRef<symbol | null>(null);
  const recoveryRawValueRef = useRef<string | null>(null);
  const discardLockRef = useRef(false);
  const isMountedRef = useRef(false);
  const dialogRef = useDialogAccessibility({
    isOpen,
    onClose,
    closeDisabled: isSubmittingSite
  });
  const hasAnalysisProgress = analysisProgress.phase !== "idle";

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
          : recovery.attempt.phase === "target-reconciling"
            ? TARGET_RECOVERY_MESSAGE
            : REQUEST_RECOVERY_MESSAGE
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
      activeOperationIdRef.current = null;
      submissionLockRef.current = false;
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
  }, [cancelScope, isOpen, resumePoint.kind]);

  useEffect(
    () => {
      isMountedRef.current = true;
      return () => {
        isMountedRef.current = false;
        activeOperationIdRef.current = null;
        submissionLockRef.current = false;
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
      submissionLockRef.current ||
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
        "서버에 페이지 또는 분석 요청이 생성되었는지 확인하셨나요? 복구 정보를 삭제하면 같은 요청을 다시 보낼 수 있습니다."
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
    if (submissionLockRef.current) {
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

    submissionLockRef.current = true;
    const operationId = Symbol("site-create-operation");
    activeOperationIdRef.current = operationId;
    const isActiveOperation = () =>
      isMountedRef.current && activeOperationIdRef.current === operationId;
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
        if (attempt > 0) {
          await wait(ANALYSIS_POLL_INTERVAL_MS, signal);
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

        if (isFinalRequestStatus(request.status)) {
          break;
        }
      }

      if (finalStatus === "FAILED") {
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
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        throw new Error("분석 엔진 실행에 실패했습니다. 대상 사이트가 자동 브라우저 접속을 차단했거나 다른 페이지로 이동했을 수 있습니다.");
      }

      if (!isFinalRequestStatus(finalStatus)) {
        throw new Error("분석 상태 확인 시간이 초과되었습니다.");
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
        throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
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
        if (activeOperationIdRef.current !== operationId) {
          return;
        }
        activeOperationIdRef.current = null;
        submissionLockRef.current = false;
        if (isMountedRef.current) {
          setIsSubmittingSite(false);
        }
        onClose();
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
        setAnalysisProgress(emptyProgress);
      } else {
        setAnalysisProgress((current) => ({
          ...current,
          phase: "failed",
          message
        }));
      }
    } finally {
      if (!keepLockedUntilAutoClose && activeOperationIdRef.current === operationId) {
        activeOperationIdRef.current = null;
        submissionLockRef.current = false;
        if (isMountedRef.current) {
          setIsSubmittingSite(false);
        }
      }
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dashboard-modal-layer fixed inset-0 flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-6">
      <div
        className="absolute inset-0"
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
        className={`relative z-10 max-h-[calc(100dvh-3rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-[18px] border p-6 ${
          isDarkMode ? "border-[#3a3a3c] bg-[#1c1c1e]" : "border-[#d2d2d7] bg-white"
        }`}
      >
        <div className="mb-4">
          <h2
            id="site-create-title"
            className={`text-lg font-semibold tracking-[-0.015em] ${
              isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"
            }`}
          >
            페이지 추가
          </h2>
        </div>

        {siteCreateError.length > 0 && (
          <div
            className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
              isDarkMode
                ? "border-[#5e2b32] bg-[#2d1d20] text-[#ff9aa8]"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {resumePoint.kind === "create" ? "페이지 추가 실패" : "페이지 등록 완료 · 분석 실패"}: {siteCreateError}
          </div>
        )}

        {hasAnalysisProgress ? (
          <AnalysisProgressPanel progress={analysisProgress} resumePoint={resumePoint} isDarkMode={isDarkMode} />
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
                maxLength={100}
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
                maxLength={2048}
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

        <div className="mt-5 flex items-center justify-between gap-3">
          {hasAnalysisProgress ? (
            <p className={`text-xs font-medium ${isDarkMode ? "text-[#8e8e93]" : "text-[#86868b]"}`}>
              {isSubmittingSite
                ? "분석 중에는 창을 닫을 수 없습니다."
                : resumePoint.kind === "create"
                  ? "입력 내용을 유지한 채 다시 시도할 수 있습니다."
                  : "페이지는 등록되어 있으며 분석 단계만 다시 시도합니다."}
            </p>
          ) : (
            <span />
          )}
          <div className="flex items-center justify-end gap-2">
            {(isRecoveryBlocked || canDiscardRecovery) && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isSubmittingSite || !canDiscardRecovery}
                onClick={handleDiscardRecovery}
                className={
                  isDarkMode
                    ? "h-7 bg-[#3a2024] px-3 text-xs text-[#ff9aa8] hover:bg-[#4a272d]"
                    : "h-7 bg-rose-50 px-3 text-xs text-rose-700 hover:bg-rose-100"
                }
              >
                복구 정보 삭제
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
              {hasAnalysisProgress && analysisProgress.phase !== "failed"
                ? "자동 닫힘"
                : analysisProgress.phase === "failed" && resumePoint.kind !== "create"
                  ? "닫기"
                  : "취소"}
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

            {analysisProgress.phase === "failed" && (
              <Button
                type="button"
                size="sm"
                disabled={isSubmittingSite || isRecoveryBlocked}
                onClick={() => {
                  void handleAddSite();
                }}
                className="h-7 bg-[#0071e3] px-5 text-xs font-semibold text-white hover:bg-[#0066cc]"
              >
                {resumePoint.kind === "create"
                  ? "다시 시도"
                  : resumePoint.kind === "request"
                    ? "분석 요청 다시 시도"
                    : "상태 확인 다시 시도"}
              </Button>
            )}
          </div>
        </div>
      </article>
    </div>
  );
}

function AnalysisProgressPanel({
  progress,
  resumePoint,
  isDarkMode
}: {
  progress: AnalysisProgress;
  resumePoint: AnalysisResumePoint;
  isDarkMode: boolean;
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
            {progress.phase === "failed" ? "분석을 완료하지 못했습니다" : "분석 진행 중"}
          </p>
          <p className={`mt-1 text-xs ${isDarkMode ? "text-[#a1a1a6]" : "text-[#68686d]"}`}>{progress.message}</p>
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
          const isActive = index === activeStepIndex && progress.phase !== "completed" && progress.phase !== "failed";
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
