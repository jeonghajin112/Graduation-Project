import { Monitor, Moon, Sun } from "lucide-react";
import { createPortal } from "react-dom";
import { useId } from "react";

import type { ThemeMode } from "@/types/theme";

import { useDialogAccessibility } from "../shared/use-dialog-accessibility";

const themeOptions: Array<{
  value: ThemeMode;
  label: string;
  Icon: typeof Monitor;
}> = [
  {
    value: "system",
    label: "시스템",
    Icon: Monitor
  },
  {
    value: "dark",
    label: "다크",
    Icon: Moon
  },
  {
    value: "light",
    label: "라이트",
    Icon: Sun
  }
];

export function AccountSettingsModal({
  isOpen,
  themeMode,
  onThemeModeChange,
  onClose
}: {
  isOpen: boolean;
  themeMode: ThemeMode;
  onThemeModeChange: (value: ThemeMode) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const themeGroupId = useId();
  const dialogRef = useDialogAccessibility({
    isOpen,
    onClose
  });

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div className="dashboard-modal-layer">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <article
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="dashboard-modal-surface w-full max-w-2xl"
      >
        <div className="flex min-h-[20rem] flex-col sm:flex-row">
          <aside
            className="dashboard-modal-settings-nav shrink-0 border-b px-3 py-6 sm:w-44 sm:border-b-0 sm:border-r"
          >
            <h3
              id={titleId}
              className="dashboard-modal-title px-2"
            >
              설정
            </h3>

            <nav className="mt-5" aria-label="설정 메뉴">
              <button
                type="button"
                aria-current="page"
                className="dashboard-modal-settings-selected flex h-9 w-full items-center rounded-lg px-2.5 text-left text-sm font-medium"
              >
                <span>일반</span>
              </button>
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <section className="flex-1 p-6" aria-labelledby={themeGroupId}>
              <h4
                id={themeGroupId}
                className="text-base font-semibold text-foreground"
              >
                테마
              </h4>
              <p className="dashboard-modal-description mt-1">
                화면에 적용할 색상 모드를 선택하세요.
              </p>

              <div
                role="radiogroup"
                aria-labelledby={themeGroupId}
                className="dashboard-modal-theme-group mt-4 grid w-full max-w-[17.5rem] grid-cols-3 gap-0.5 rounded-lg p-0.5"
              >
                  {themeOptions.map(({ value, label, Icon }) => {
                    const selected = themeMode === value;
                    const optionId = `${themeGroupId}-${value}`;

                    return (
                      <label
                        key={value}
                        htmlFor={optionId}
                        data-selected={selected}
                        className="dashboard-modal-theme-option relative flex cursor-pointer items-center justify-center gap-1 rounded-md px-1.5 text-[0.6875rem] font-medium leading-none"
                      >
                        <input
                          id={optionId}
                          type="radio"
                          name="account-settings-theme"
                          value={value}
                          checked={selected}
                          onChange={() => onThemeModeChange(value)}
                          className="sr-only"
                        />
                        <Icon size={13} strokeWidth={1.9} className="shrink-0" aria-hidden="true" />
                        <span className="inline-flex h-3.5 items-center leading-none">{label}</span>
                        {selected ? <span className="sr-only"> (선택됨)</span> : null}
                      </label>
                    );
                  })}
              </div>
            </section>

            <div className="flex items-center justify-end px-6 pb-6">
              <button
                type="button"
                onClick={onClose}
                className="dashboard-modal-button"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      </article>
    </div>,
    document.body
  );
}
