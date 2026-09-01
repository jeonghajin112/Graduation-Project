import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { PanelMessage } from "../shared/display";
import { useDialogAccessibility } from "../shared/use-dialog-accessibility";

export function OrganizationModelCreateModal({
  isOpen,
  isDarkMode,
  name,
  isSubmitting,
  hasCreatedOrganization,
  canDiscardRecovery,
  isRecoveryBlocked,
  errorMessage,
  onNameChange,
  onClose,
  onSubmit,
  onDiscardRecovery
}: {
  isOpen: boolean;
  isDarkMode: boolean;
  name: string;
  isSubmitting: boolean;
  hasCreatedOrganization: boolean;
  canDiscardRecovery: boolean;
  isRecoveryBlocked: boolean;
  errorMessage: string;
  onNameChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  onDiscardRecovery: () => void;
}) {
  const hasRecovery = hasCreatedOrganization || isRecoveryBlocked;
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
    <div className="dashboard-modal-layer fixed inset-0 flex items-center justify-center bg-black/60 px-4 py-6">
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
        className={`relative z-10 w-full max-w-md rounded-[18px] border p-6 ${
          isDarkMode ? "border-[#3a3a3c] bg-[#1c1c1e]" : "border-[#d2d2d7] bg-white"
        }`}
      >
        <h3
          id="organization-create-title"
          className={`text-lg font-semibold tracking-[-0.015em] ${
            isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"
          }`}
        >
          프로젝트 추가
        </h3>

        {errorMessage.length > 0 && (
          <PanelMessage
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
            className={
              isDarkMode
                ? "border-[#3a3a3c] bg-[#242426] text-[#f5f5f7] placeholder:text-[#8e8e93] focus-visible:border-white focus-visible:ring-0"
                : "border-[#d2d2d7] bg-white text-[#1d1d1f] placeholder:text-[#86868b] focus-visible:border-[#1d1d1f] focus-visible:ring-0"
            }
            placeholder="프로젝트 이름"
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
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
              className="h-7 px-4 text-xs font-semibold"
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
            className={
              isDarkMode
                ? "h-7 bg-[#2c2c2e] px-5 text-xs text-[#f5f5f7] hover:bg-[#3a3a3c]"
                : "h-7 bg-[#e5e5ea] px-5 text-xs text-[#1d1d1f] hover:bg-[#d2d2d7]"
            }
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
              className="h-7 bg-[#0071e3] px-5 text-xs font-semibold text-white hover:bg-[#0066cc]"
            >
              {hasCreatedOrganization
                ? isSubmitting
                  ? "목록 불러오는 중..."
                  : "프로젝트 불러오기 다시 시도"
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
