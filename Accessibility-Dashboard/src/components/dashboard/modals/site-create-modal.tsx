import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { throwIfAborted } from "@/services/async-cancellation";
import { getApiErrorMessage, isAbortError } from "@/services/backend-api";
import {
  SITE_NAME_MAX_LENGTH,
  SITE_URL_MAX_LENGTH,
  clearSiteCreateRecovery,
  isValidEvaluationTargetAccessUrl,
  readSiteCreateRecovery
} from "@/services/site-create-recovery-storage";
import type { PersistedSiteCreateAttempt } from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  CreateEvaluationTargetInput as CreateEvaluationTargetModelInput,
  EvaluationRequestModel,
  OrganizationModel
} from "@/types/accessibility-domain";

import { EVALUATION_REQUEST_FAILED_MESSAGE } from "../shared/evaluation-request-status";
import { useDialogAccessibility } from "../shared/use-dialog-accessibility";
import { useMutationOperation } from "../shared/use-mutation-operation";


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



type AnalysisRecoveryPhase = "ready" | "paused" | "failed" | null;

type AnalysisResumePoint =
  | { kind: "create" }
  | { kind: "request"; targetId: number; previousFailedRequestId?: number }
  | { kind: "poll"; targetId: number; requestId: number };

const initialResumePoint: AnalysisResumePoint = { kind: "create" };

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

function recoveryPhaseFromPersistedAttempt(
  attempt: PersistedSiteCreateAttempt
): AnalysisRecoveryPhase {
  if (attempt.phase === "target-reconciling") {
    return null;
  }
  if (attempt.phase === "request-ready") {
    return attempt.previousFailedRequestId === null ? "ready" : "failed";
  }
  return "paused";
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

export function SiteCreateModal({
  isOpen,
  isDarkMode,
  project,
  onCreateEvaluationTargetModel,
  onRequestEvaluationTargetAnalysis,
  onAnalysisAccepted,
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
  onAnalysisAccepted: (request: EvaluationRequestModel, url: string) => void;
  onClose: () => void;
}) {
  const [siteName, setSiteName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isSubmittingSite, setIsSubmittingSite] = useState(false);
  const [siteCreateError, setSiteCreateError] = useState("");
  const [recoveryPhase, setRecoveryPhase] = useState<AnalysisRecoveryPhase>(null);
  const [resumePoint, setResumePoint] = useState<AnalysisResumePoint>(initialResumePoint);
  const [isRecoveryBlocked, setIsRecoveryBlocked] = useState(false);
  const [canDiscardRecovery, setCanDiscardRecovery] = useState(false);
  const {
    beginMutationOperation,
    cancelMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent,
    isMutationOperationLocked
  } = useMutationOperation();
  const recoveryRawValueRef = useRef<string | null>(null);
  const discardLockRef = useRef(false);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useDialogAccessibility({
    isOpen,
    onClose,
    closeDisabled: isSubmittingSite
  });
  const isAnalysisNotice =
    recoveryPhase === "ready" || recoveryPhase === "paused";

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
      setRecoveryPhase(null);
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
      setRecoveryPhase(recoveryPhaseFromPersistedAttempt(recovery.attempt));
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
      setRecoveryPhase(null);
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
    setRecoveryPhase(null);
    setSiteName("");
    setBaseUrl("");
    setSiteCreateError("");
  }, [isOpen, project.id]);

  useEffect(() => {
    if (!isOpen) {
      // Cancel only this form's submission/recovery. The dashboard owns accepted jobs.
      cancelMutationOperation();
      discardLockRef.current = false;
      setIsSubmittingSite(false);
      if (resumePoint.kind === "create") {
        setSiteName("");
        setBaseUrl("");
        setSiteCreateError("");
        setRecoveryPhase(null);
      }
    }
  }, [cancelMutationOperation, isOpen, resumePoint.kind]);

  const handleDiscardRecovery = () => {
    if (
      discardLockRef.current ||
      isMutationOperationLocked() ||
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
    setRecoveryPhase(null);
    setSiteName("");
    setBaseUrl("");
    setSiteCreateError("");
    discardLockRef.current = false;
  };

  const handleAddSite = async () => {
    if (isMutationOperationLocked()) {
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

    const operation = beginMutationOperation("site-create-operation");
    if (operation === null) {
      return;
    }
    const isActiveOperation = () => isMutationOperationCurrent(operation);


    // Aborts when the modal closes or unmounts.
    const { signal } = operation;

    setIsSubmittingSite(true);
    setSiteCreateError("");
    setRecoveryPhase(null);

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
      } else {
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
      }

      onAnalysisAccepted({
        id: requestId,
        evaluationTargetId: targetId,
        status: "PENDING",
        requestedAt: new Date().toISOString(),
        updatedAt: ""
      }, accessUrl);

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

      setRecoveryPhase(null);
      setResumePoint(initialResumePoint);
      setSiteName("");
      setBaseUrl("");

      onClose();
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
        setRecoveryPhase(null);
      } else {
        const persistedRecovery = readSiteCreateRecovery();
        const persistedAttempt =
          persistedRecovery.kind === "valid" &&
          persistedRecovery.attempt.projectId === project.id
            ? persistedRecovery.attempt
            : null;
        const nextRecoveryPhase: AnalysisRecoveryPhase = persistedAttempt?.phase === "request-reconciling" ||
              persistedAttempt?.phase === "poll" ||
              nextResumePoint.kind === "poll"
            ? "paused"
            : persistedAttempt?.phase === "request-ready" &&
                persistedAttempt.previousFailedRequestId === null
              ? "ready"
              : "failed";
        setRecoveryPhase(nextRecoveryPhase);
      }
    } finally {
      // The request-recovery hook binds its in-memory directory lease to this
      // operation scope. Ending the scope releases that lease while the
      // persisted checkpoint remains available for a deliberate retry.
      if (finishMutationOperation(operation)) {
        setIsSubmittingSite(false);
      }
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dashboard-modal-layer">
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
        className="dashboard-modal-surface dashboard-modal-surface--split w-full max-w-md"
      >
        <header className="shrink-0 px-6 pb-4 pt-6">
          <h2
            id="site-create-title"
            className="dashboard-modal-title"
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
          className="site-create-modal-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-1.5 px-6 pb-1.5"
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
                : recoveryPhase === "ready"
                  ? "페이지 등록 완료 · 분석 시작 전"
                  : recoveryPhase === "paused"
                  ? "페이지 등록 완료 · 상태 확인 필요"
                  : "페이지 등록 완료 · 분석 실패"}: {siteCreateError}
            </div>
          )}

          <div className="grid gap-3.5">
            <label className="block">
              <span className="dashboard-modal-label">페이지 이름</span>
              <Input
                value={siteName}
                onChange={(event) => setSiteName(event.target.value)}
                disabled={isSubmittingSite || isRecoveryBlocked || resumePoint.kind !== "create"}
                maxLength={SITE_NAME_MAX_LENGTH}
                placeholder="페이지 이름 입력"
                className="dashboard-modal-input"
              />
            </label>

            <label className="block">
              <span className="dashboard-modal-label">페이지 주소</span>
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                disabled={isSubmittingSite || isRecoveryBlocked || resumePoint.kind !== "create"}
                maxLength={SITE_URL_MAX_LENGTH}
                placeholder="https://example.com"
                className="dashboard-modal-input"
              />
            </label>
          </div>
        </div>

        <div
          data-site-create-footer
          className="flex shrink-0 flex-col items-stretch gap-3 px-6 pb-6 pt-3.5 sm:flex-row sm:items-center sm:justify-between"
        >
          <span />
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0">
            {(isRecoveryBlocked || canDiscardRecovery) && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isSubmittingSite || !canDiscardRecovery}
                onClick={handleDiscardRecovery}
                className="dashboard-modal-button dashboard-modal-button--danger"
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
              className="dashboard-modal-button"
            >
              {resumePoint.kind !== "create" ? "닫기" : "취소"}
            </Button>

            <Button
              type="button"
              size="sm"
              disabled={isSubmittingSite || isRecoveryBlocked}
              aria-busy={isSubmittingSite}
              onClick={() => {
                void handleAddSite();
              }}
              className="dashboard-modal-button dashboard-modal-button--primary"
            >
              {isSubmittingSite
                ? "요청 중…"
                : recoveryPhase === null || recoveryPhase === "ready"
                  ? "분석 시작"
                  : recoveryPhase === "paused" && resumePoint.kind === "request"
                    ? "분석 시작 여부 확인"
                    : resumePoint.kind === "create"
                      ? "다시 시도"
                      : resumePoint.kind === "request"
                        ? "분석 요청 다시 시도"
                        : "상태 확인 다시 시도"}
            </Button>
          </div>
        </div>
      </article>
    </div>
  );
}
