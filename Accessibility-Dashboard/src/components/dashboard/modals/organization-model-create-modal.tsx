import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { PanelMessage } from "../shared/display";
import { preventAccidentalSubmit } from "../shared/form-keyboard";
import { useDialogAccessibility } from "../shared/use-dialog-accessibility";

export function OrganizationModelCreateModal({
  isOpen,
  name,
  isSubmitting,
  hasPendingOrganizationCreate,
  canDiscardRecovery,
  isRecoveryBlocked,
  errorMessage,
  onNameChange,
  onClose,
  onSubmit,
  onDiscardRecovery
}: {
  isOpen: boolean;
  name: string;
  isSubmitting: boolean;
  hasPendingOrganizationCreate: boolean;
  canDiscardRecovery: boolean;
  isRecoveryBlocked: boolean;
  errorMessage: string;
  onNameChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  onDiscardRecovery: () => void;
}) {
  const hasRecovery = hasPendingOrganizationCreate || isRecoveryBlocked;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const previousHasRecoveryRef = useRef(hasRecovery);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const wasSubmittingRef = useRef(isSubmitting);
  const errorId = useId();
  const isNameInvalid = errorMessage.length > 0 && !hasRecovery;
  const dialogRef = useDialogAccessibility<HTMLFormElement>({
    isOpen,
    onClose,
    closeDisabled: isSubmitting
  });

  useEffect(() => {
    const didFinishRecovery = previousHasRecoveryRef.current && !hasRecovery;
    previousHasRecoveryRef.current = hasRecovery;
    if (!isOpen || !didFinishRecovery) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [hasRecovery, isOpen]);

  // The name input and buttons are disabled while the request runs; keep
  // keyboard focus inside the dialog and return it once the request settles.
  useEffect(() => {
    const dialog = dialogRef.current;
    const wasSubmitting = wasSubmittingRef.current;
    wasSubmittingRef.current = isSubmitting;
    if (!isOpen || !dialog) {
      return;
    }
    const active = document.activeElement;
    const focusLost =
      !(active instanceof HTMLElement) ||
      !dialog.contains(active) ||
      (active as HTMLButtonElement | HTMLInputElement).disabled === true;
    if (isSubmitting) {
      if (focusLost) dialog.focus({ preventScroll: true });
      return;
    }
    if (!wasSubmitting || (!focusLost && active !== dialog)) {
      return;
    }
    const target = [nameInputRef.current, submitButtonRef.current].find(
      (element) => element && !element.disabled
    ) ?? dialog;
    target.focus({ preventScroll: true });
  }, [dialogRef, isOpen, isSubmitting]);

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div className="dashboard-modal-layer">
      <div
        className="absolute inset-0"
        aria-hidden="true"
        onClick={() => {
          if (!isSubmitting) {
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
          if (!isSubmitting && !isRecoveryBlocked) void onSubmit();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-create-title"
        tabIndex={-1}
        className="dashboard-modal-surface dashboard-modal-content w-full max-w-md"
      >
        <h3
          id="organization-create-title"
          className="dashboard-modal-title"
        >
          프로젝트 추가
        </h3>

        {errorMessage.length > 0 && (
          <div id={errorId}>
            <PanelMessage
              className="dashboard-modal-message"
              label={hasRecovery ? errorMessage : `프로젝트 생성 실패: ${errorMessage}`}
              isError
            />
          </div>
        )}

        <div className="mt-5">
          <Input
            ref={nameInputRef}
            aria-label="프로젝트 이름"
            aria-invalid={isNameInvalid || undefined}
            aria-describedby={errorMessage.length > 0 ? errorId : undefined}
            autoComplete="off"
            value={name}
            maxLength={100}
            disabled={isSubmitting || hasRecovery}
            onChange={(event) => onNameChange(event.target.value)}
            className="dashboard-modal-input"
            placeholder="프로젝트 이름"
          />
        </div>

        <div className="dashboard-modal-actions">
          {canDiscardRecovery && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={isSubmitting}
              onClick={() => {
                const shouldDiscard = window.confirm(
                  "프로젝트가 이미 생성되지 않았는지 목록에서 확인하셨나요? 이전 작업 정보를 삭제하면 같은 프로젝트가 다시 생성될 수 있습니다. 그래도 삭제할까요?"
                );
                if (shouldDiscard) {
                  onDiscardRecovery();
                }
              }}
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
            {hasRecovery ? "닫기" : "취소"}
          </Button>
          {!isRecoveryBlocked && (
            <Button
              ref={submitButtonRef}
              type="submit"
              size="sm"
              disabled={isSubmitting}
              className="dashboard-modal-button dashboard-modal-button--primary"
            >
              {hasPendingOrganizationCreate
                ? isSubmitting
                  ? "처리 중..."
                  : "프로젝트 다시 시도"
                : isSubmitting
                  ? "생성 중..."
                  : "생성"}
            </Button>
          )}
        </div>
      </form>
    </div>,
    document.body
  );
}
