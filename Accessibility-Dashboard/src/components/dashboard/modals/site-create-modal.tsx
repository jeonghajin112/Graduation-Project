import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { preventAccidentalSubmit } from "../shared/form-keyboard";
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
import { useMutationOperation, type MutationOperation } from "../shared/use-mutation-operation";
import { isDialogFocusLost } from "./dialog-submit-focus";


type SiteCreateField = "name" | "url";

function siteInputRejection(
  name: string,
  accessUrl: string
): { field: SiteCreateField; message: string } | null {
  if (name.length === 0 || accessUrl.length === 0) {
    return { field: name.length === 0 ? "name" : "url", message: "페이지 이름과 주소를 입력해주세요." };
  }
  if (name.length > SITE_NAME_MAX_LENGTH) {
    return { field: "name", message: `페이지 이름은 ${SITE_NAME_MAX_LENGTH}자 이하로 입력해주세요.` };
  }
  if (!isValidEvaluationTargetAccessUrl(accessUrl)) {
    return { field: "url", message: "올바른 페이지 주소를 입력해주세요. 예: https://example.com" };
  }
  return null;
}

function readProjectSiteCreateRecovery(projectId: number) {
  const recovery = readSiteCreateRecovery();
  return recovery.kind === "valid" && recovery.attempt.projectId === projectId ? recovery : null;
}

/** False when the stored checkpoint is not this accepted request or cannot be removed. */
function clearAcceptedSiteCreateRecovery(targetId: number, requestId: number): boolean {
  const completedRecovery = readSiteCreateRecovery();
  if (completedRecovery.kind === "blocked") return false;
  if (completedRecovery.kind !== "valid") return true;
  const { attempt } = completedRecovery;
  return (
    attempt.phase === "poll" &&
    attempt.targetId === targetId &&
    attempt.requestId === requestId &&
    clearSiteCreateRecovery(completedRecovery.rawValue)
  );
}

function siteCreateNoticeTitle(resumePoint: AnalysisResumePoint, recoveryPhase: AnalysisRecoveryPhase) {
  if (resumePoint.kind === "create") return "페이지 추가 실패";
  if (recoveryPhase === "ready") return "페이지 등록 완료 · 분석 시작 전";
  return recoveryPhase === "paused"
    ? "페이지 등록 완료 · 상태 확인 필요"
    : "페이지 등록 완료 · 분석 실패";
}

function siteCreateSubmitLabel(
  isSubmitting: boolean,
  recoveryPhase: AnalysisRecoveryPhase,
  resumePoint: AnalysisResumePoint
) {
  if (isSubmitting) return "요청 중…";
  if (recoveryPhase === null || recoveryPhase === "ready") return "분석 시작";
  if (recoveryPhase === "paused" && resumePoint.kind === "request") return "분석 시작 여부 확인";
  if (resumePoint.kind === "create") return "다시 시도";
  return resumePoint.kind === "request" ? "분석 요청 다시 시도" : "상태 확인 다시 시도";
}

function SiteCreateInput({
  label,
  inputRef,
  value,
  onChange,
  isInvalid,
  error,
  errorId,
  inputMode,
  autoComplete,
  disabled,
  maxLength,
  placeholder
}: {
  label: string;
  inputRef: RefObject<HTMLInputElement>;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  isInvalid: boolean;
  error: string;
  errorId: string;
  inputMode?: "url";
  autoComplete: string;
  disabled: boolean;
  maxLength: number;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="dashboard-modal-label">{label}</span>
      <Input
        ref={inputRef}
        value={value}
        onChange={onChange}
        aria-invalid={isInvalid || undefined}
        aria-describedby={isInvalid && error ? errorId : undefined}
        inputMode={inputMode}
        autoComplete={autoComplete}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        className="dashboard-modal-input"
      />
    </label>
  );
}

function SiteCreateFooter({
  isSubmitting,
  isRecoveryBlocked,
  canDiscardRecovery,
  recoveryPhase,
  resumePoint,
  submitButtonRef,
  onDiscardRecovery,
  onClose
}: {
  isSubmitting: boolean;
  isRecoveryBlocked: boolean;
  canDiscardRecovery: boolean;
  recoveryPhase: AnalysisRecoveryPhase;
  resumePoint: AnalysisResumePoint;
  submitButtonRef: RefObject<HTMLButtonElement>;
  onDiscardRecovery: () => void;
  onClose: () => void;
}) {
  return (
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
            disabled={isSubmitting || !canDiscardRecovery}
            onClick={onDiscardRecovery}
            className="dashboard-modal-button dashboard-modal-button--danger"
          >
            이전 작업 정보 삭제
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={isSubmitting}
          onClick={onClose}
          className="dashboard-modal-button"
        >
          {resumePoint.kind !== "create" ? "닫기" : "취소"}
        </Button>

        <Button
          ref={submitButtonRef}
          type="submit"
          size="sm"
          disabled={isSubmitting || isRecoveryBlocked}
          aria-busy={isSubmitting}
          className="dashboard-modal-button dashboard-modal-button--primary"
        >
          {siteCreateSubmitLabel(isSubmitting, recoveryPhase, resumePoint)}
        </Button>
      </div>
    </div>
  );
}

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
  const isFieldLocked = isSubmittingSite || isRecoveryBlocked || resumePoint.kind !== "create";

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
    const focusLost = isDialogFocusLost(dialog, active);
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

  const recoverFromSubmitFailure = (
    error: unknown,
    operation: MutationOperation,
    failedAt: AnalysisResumePoint
  ) => {
    if (isAbortError(error) || !isMutationOperationCurrent(operation)) {
      return;
    }

    setResumePoint(failedAt);
    const message = getApiErrorMessage(
      error,
      failedAt.kind === "create"
        ? "페이지를 추가하지 못했습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요."
        : "페이지는 등록되었지만 분석을 시작하지 못했습니다. 분석만 다시 시도해 주세요."
    );
    setSiteCreateError(message);
    if (failedAt.kind === "create") {
      const unresolvedRecovery = readProjectSiteCreateRecovery(project.id);
      if (unresolvedRecovery !== null) {
        recoveryRawValueRef.current = unresolvedRecovery.rawValue;
        setCanDiscardRecovery(true);
      }
      setRecoveryPhase(null);
    } else {
      const persistedRecovery = readProjectSiteCreateRecovery(project.id);
      setRecoveryPhase(phaseAfterFailedRequest(persistedRecovery?.attempt ?? null, failedAt));
    }
  };

  const submitSite = async (operation: MutationOperation, name: string, accessUrl: string) => {
    const isActiveOperation = () => isMutationOperationCurrent(operation);

    // Aborts when the modal closes or unmounts.
    const { signal } = operation;

    setIsSubmittingSite(true);
    setSiteCreateError("");
    setInvalidField(null);
    setRecoveryPhase(null);

    let nextResumePoint = resumePoint;

    try {
      if (nextResumePoint.kind === "create") {
        const targetId = await onCreateEvaluationTargetModel(
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
        nextResumePoint = { kind: "request", targetId };
        setResumePoint(nextResumePoint);
      }

      if (nextResumePoint.kind === "request") {
        const { targetId } = nextResumePoint;
        const requestId = await onRequestEvaluationTargetAnalysis(
          targetId,
          signal,
          nextResumePoint.previousFailedRequestId
        );
        if (!isActiveOperation()) {
          return;
        }
        nextResumePoint = { kind: "poll", targetId, requestId };
        setResumePoint(nextResumePoint);
      }

      const { targetId, requestId } = nextResumePoint;
      onAnalysisAccepted({
        id: requestId,
        evaluationTargetId: targetId,
        status: "PENDING",
        // No server submission time yet; ordering falls back to the request ID
        // instead of mixing the browser clock with server timestamps.
        requestedAt: "",
        updatedAt: ""
      }, accessUrl);

      if (!clearAcceptedSiteCreateRecovery(targetId, requestId)) {
        throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }

      applyRecoveryForm(EMPTY_RECOVERY_FORM);
      onClose();
    } catch (error) {
      recoverFromSubmitFailure(error, operation, nextResumePoint);
    } finally {
      // The request-recovery hook binds its in-memory directory lease to this
      // operation scope. Ending the scope releases that lease while the
      // persisted checkpoint remains available for a deliberate retry.
      if (finishMutationOperation(operation)) {
        setIsSubmittingSite(false);
      }
    }
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

    const rejection = resumePoint.kind === "create" ? siteInputRejection(name, accessUrl) : null;
    if (rejection !== null) {
      rejectField(rejection.field, rejection.message);
      return;
    }
    setInvalidField(null);

    const operation = beginMutationOperation("site-create-operation");
    if (operation === null) {
      return;
    }
    await submitSite(operation, name, accessUrl);
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
              {siteCreateNoticeTitle(resumePoint, recoveryPhase)}: {siteCreateError}
            </div>
          )}

          <div className="grid gap-3.5">
            <SiteCreateInput
              label="페이지 이름"
              inputRef={nameInputRef}
              value={siteName}
              onChange={(event) => {
                setSiteName(event.target.value);
                if (invalidField === "name") setInvalidField(null);
              }}
              isInvalid={invalidField === "name"}
              error={siteCreateError}
              errorId={errorId}
              autoComplete="off"
              disabled={isFieldLocked}
              maxLength={SITE_NAME_MAX_LENGTH}
              placeholder="페이지 이름 입력"
            />

            <SiteCreateInput
              label="페이지 주소"
              inputRef={urlInputRef}
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                if (invalidField === "url") setInvalidField(null);
              }}
              isInvalid={invalidField === "url"}
              error={siteCreateError}
              errorId={errorId}
              inputMode="url"
              autoComplete="url"
              disabled={isFieldLocked}
              maxLength={SITE_URL_MAX_LENGTH}
              placeholder="https://example.com"
            />
          </div>
        </div>

        <SiteCreateFooter
          isSubmitting={isSubmittingSite}
          isRecoveryBlocked={isRecoveryBlocked}
          canDiscardRecovery={canDiscardRecovery}
          recoveryPhase={recoveryPhase}
          resumePoint={resumePoint}
          submitButtonRef={submitButtonRef}
          onDiscardRecovery={handleDiscardRecovery}
          onClose={onClose}
        />
      </form>
    </div>,
    document.body
  );
}
