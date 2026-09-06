import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { PanelMessage } from "../shared/display";
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
  const dialogRef = useDialogAccessibility({
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

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div className="dashboard-modal-layer">
      <div
        className="absolute inset-0"
        onClick={() => {
          if (!isSubmitting) {
            onClose();
          }
        }}
      />
      <article
        ref={dialogRef}
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
          <PanelMessage
            className="dashboard-modal-message"
            label={hasRecovery ? errorMessage : `프로젝트 생성 실패: ${errorMessage}`}
            isError
          />
        )}

        <div className="mt-5">
          <Input
            ref={nameInputRef}
            aria-label="프로젝트 이름"
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
              type="button"
              size="sm"
              disabled={isSubmitting}
              onClick={() => {
                void onSubmit();
              }}
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
      </article>
    </div>,
    document.body
  );
}
