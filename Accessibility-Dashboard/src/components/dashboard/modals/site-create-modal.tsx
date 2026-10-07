import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { preventAccidentalSubmit } from "../shared/form-keyboard";
import { throwIfAborted } from "@/services/async-cancellation";
import { getApiErrorMessage, isAbortError } from "@/services/backend-api";
import {
  SITE_NAME_MAX_LENGTH,
  SITE_URL_MAX_LENGTH,
  clearSiteCreateRecovery,
  isValidEvaluationTargetAccessUrl,
  readSiteCreateRecovery
} from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  CreateEvaluationTargetInput as CreateEvaluationTargetModelInput,
  EvaluationRequestModel,
  OrganizationModel
} from "@/types/accessibility-domain";

import {
  EMPTY_RECOVERY_FORM,
  SITE_RECOVERY_BLOCKED_MESSAGE,
  SITE_RECOVERY_PERSISTENCE_MESSAGE,
  initialResumePoint,
  phaseAfterFailedRequest,
  recoveryFormFromRead,
  type AnalysisRecoveryPhase,
  type AnalysisResumePoint,
  type SiteCreateRecoveryForm
} from "./site-create-recovery-form";
import { useDialogAccessibility } from "../shared/use-dialog-accessibility";
import { useMutationOperation } from "../shared/use-mutation-operation";


type SiteCreateField = "name" | "url";

export function SiteCreateModal({
  isOpen,
  project,
  onCreateEvaluationTargetModel,
  onRequestEvaluationTargetAnalysis,
  onAnalysisAccepted,
  onClose
}: {
  isOpen: boolean;
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
  const [invalidField, setInvalidField] = useState<SiteCreateField | null>(null);
  const errorId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const wasSubmittingRef = useRef(false);
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
  const dialogRef = useDialogAccessibility<HTMLFormElement>({
    isOpen,
    onClose,
    closeDisabled: isSubmittingSite
  });
  const isAnalysisNotice =
    recoveryPhase === "ready" || recoveryPhase === "paused";

  const applyRecoveryForm = useCallback((form: SiteCreateRecoveryForm) => {
    recoveryRawValueRef.current = form.rawValue;
    setIsRecoveryBlocked(form.isBlocked);
    setCanDiscardRecovery(form.canDiscard);
    setResumePoint(form.resumePoint);
    setRecoveryPhase(form.phase);
    setSiteName(form.siteName);
    setBaseUrl(form.baseUrl);
    setSiteCreateError(form.message);
  }, []);

  const focusField = (field: SiteCreateField) => {
    window.requestAnimationFrame(() => {
      (field === "name" ? nameInputRef : urlInputRef).current?.focus({ preventScroll: false });
    });
  };

  const rejectField = (field: SiteCreateField, message: string) => {
    setInvalidField(field);
    setSiteCreateError(message);
    focusField(field);
  };

  // Disabling the focused control while a request runs would drop keyboard
  // focus onto <body>. Park it on the dialog, then hand it back afterwards.
  useEffect(() => {
    const dialog = dialogRef.current;
    const wasSubmitting = wasSubmittingRef.current;
    wasSubmittingRef.current = isSubmittingSite;
    if (!isOpen || !dialog) {
      return;
    }
    const active = document.activeElement;
    const focusLost =
      !(active instanceof HTMLElement) ||
      !dialog.contains(active) ||
      (active as HTMLButtonElement | HTMLInputElement).disabled === true;
    if (isSubmittingSite) {
      if (focusLost) dialog.focus({ preventScroll: true });
      return;
    }
    if (!wasSubmitting || (!focusLost && active !== dialog)) {
      return;
    }
    const candidates = [
      invalidField === "url" ? urlInputRef.current : nameInputRef.current,
      nameInputRef.current,
      submitButtonRef.current
    ];
    const target = candidates.find((element) => element && !element.disabled) ?? dialog;
    target.focus({ preventScroll: true });
  }, [dialogRef, invalidField, isOpen, isSubmittingSite]);

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
    applyRecoveryForm(recoveryFormFromRead(recovery, project.id));
    if (recovery.kind === "none") {
      setInvalidField(null);
    }
  }, [applyRecoveryForm, isOpen, project.id]);

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
        setInvalidField(null);
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

    applyRecoveryForm(EMPTY_RECOVERY_FORM);
    setInvalidField(null);
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
      rejectField(name.length === 0 ? "name" : "url", "페이지 이름과 주소를 입력해주세요.");
      return;
    }
    if (resumePoint.kind === "create" && name.length > SITE_NAME_MAX_LENGTH) {
      rejectField("name", `페이지 이름은 ${SITE_NAME_MAX_LENGTH}자 이하로 입력해주세요.`);
      return;
    }
    if (resumePoint.kind === "create" && !isValidEvaluationTargetAccessUrl(accessUrl)) {
      rejectField("url", "올바른 페이지 주소를 입력해주세요. 예: https://example.com");
      return;
    }
    setInvalidField(null);

    const operation = beginMutationOperation("site-create-operation");
    if (operation === null) {
      return;
    }
    const isActiveOperation = () => isMutationOperationCurrent(operation);


    // Aborts when the modal closes or unmounts.
    const { signal } = operation;

    setIsSubmittingSite(true);
    setSiteCreateError("");
    setInvalidField(null);
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
        // No server submission time yet; ordering falls back to the request ID
        // instead of mixing the browser clock with server timestamps.
        requestedAt: "",
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

      applyRecoveryForm(EMPTY_RECOVERY_FORM);
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
        setRecoveryPhase(phaseAfterFailedRequest(persistedAttempt, nextResumePoint));
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

  return createPortal(
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

      <form
        ref={dialogRef}
        noValidate
        onKeyDown={preventAccidentalSubmit}
        onSubmit={(event) => {
          event.preventDefault();
          if (!isSubmittingSite && !isRecoveryBlocked) void handleAddSite();
        }}
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
              id={errorId}
              role="alert"
              data-tone={isAnalysisNotice ? "warning" : "danger"}
              className="dashboard-inline-notice mb-4 rounded-lg border px-3 py-2 text-xs"
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
                ref={nameInputRef}
                value={siteName}
                onChange={(event) => {
                  setSiteName(event.target.value);
                  if (invalidField === "name") setInvalidField(null);
                }}
                aria-invalid={invalidField === "name" || undefined}
                aria-describedby={invalidField === "name" && siteCreateError ? errorId : undefined}
                autoComplete="off"
                disabled={isSubmittingSite || isRecoveryBlocked || resumePoint.kind !== "create"}
                maxLength={SITE_NAME_MAX_LENGTH}
                placeholder="페이지 이름 입력"
                className="dashboard-modal-input"
              />
            </label>

            <label className="block">
              <span className="dashboard-modal-label">페이지 주소</span>
              <Input
                ref={urlInputRef}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  if (invalidField === "url") setInvalidField(null);
                }}
                aria-invalid={invalidField === "url" || undefined}
                aria-describedby={invalidField === "url" && siteCreateError ? errorId : undefined}
                inputMode="url"
                autoComplete="url"
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
              ref={submitButtonRef}
              type="submit"
              size="sm"
              disabled={isSubmittingSite || isRecoveryBlocked}
              aria-busy={isSubmittingSite}
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
      </form>
    </div>,
    document.body
  );
}
