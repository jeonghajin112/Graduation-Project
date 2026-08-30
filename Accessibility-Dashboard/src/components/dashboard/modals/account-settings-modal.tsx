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
  isDarkMode,
  themeMode,
  onThemeModeChange,
  onClose
}: {
  isOpen: boolean;
  isDarkMode: boolean;
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
    <div className="dashboard-modal-layer fixed inset-0 flex items-center justify-center bg-black/60 px-4 py-6">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <article
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative z-10 w-full max-w-2xl overflow-hidden rounded-[18px] border outline-none ${
          isDarkMode ? "border-[#3a3a3c] bg-[#1c1c1e]" : "border-[#d2d2d7] bg-white"
        }`}
      >
        <div className="flex min-h-[20rem] flex-col sm:flex-row">
          <aside
            className={`shrink-0 border-b px-3 py-5 sm:w-44 sm:border-b-0 sm:border-r ${
              isDarkMode ? "border-[#3a3a3c] bg-[#18181a]" : "border-[#e5e5ea] bg-[#f5f5f7]"
            }`}
          >
            <h3
              id={titleId}
              className={`px-2 text-lg font-semibold tracking-[-0.015em] ${
                isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"
              }`}
            >
              설정
            </h3>

            <nav className="mt-5" aria-label="설정 메뉴">
              <button
                type="button"
                aria-current="page"
                className={`flex h-9 w-full items-center rounded-lg px-2.5 text-left text-sm font-medium ${
                  isDarkMode
                    ? "bg-[#2c2c2e] text-[#f5f5f7]"
                    : "bg-[#e5e5ea] text-[#1d1d1f]"
                }`}
              >
                <span>일반</span>
              </button>
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <section className="flex-1 p-5 sm:p-6" aria-labelledby={themeGroupId}>
              <h4
                id={themeGroupId}
                className={`text-base font-semibold tracking-[-0.015em] ${
                  isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"
                }`}
              >
                테마
              </h4>
              <p className={`mt-1 text-xs ${isDarkMode ? "text-[#a1a1a6]" : "text-[#6e6e73]"}`}>
                화면에 적용할 색상 모드를 선택하세요.
              </p>

              <div
                role="radiogroup"
                aria-labelledby={themeGroupId}
                className={`mt-4 grid w-full max-w-[17.5rem] grid-cols-3 gap-0.5 rounded-lg p-0.5 ${
                  isDarkMode ? "bg-[#2c2c2e]" : "bg-[#e5e5ea]"
                }`}
              >
                  {themeOptions.map(({ value, label, Icon }) => {
                    const selected = themeMode === value;
                    const optionId = `${themeGroupId}-${value}`;

                    return (
                      <label
                        key={value}
                        htmlFor={optionId}
                        className={`relative flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md px-1.5 text-[0.6875rem] font-medium leading-none transition-colors focus-within:outline focus-within:outline-1 focus-within:outline-offset-0 ${
                          selected
                            ? isDarkMode
                              ? "bg-[#f5f5f7] text-[#1d1d1f] focus-within:outline-white"
                              : "bg-[#1d1d1f] text-white focus-within:outline-[#1d1d1f]"
                            : isDarkMode
                              ? "text-[#d1d1d6] hover:bg-[#3a3a3c] focus-within:outline-white"
                              : "text-[#3a3a3c] hover:bg-[#d2d2d7] focus-within:outline-[#1d1d1f]"
                        }`}
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

            <div className="flex items-center justify-end px-5 py-4 sm:px-6">
              <button
                type="button"
                onClick={onClose}
                className={`inline-flex h-7 items-center justify-center rounded-lg px-5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/60 ${
                  isDarkMode
                    ? "bg-[#2c2c2e] text-[#f5f5f7] hover:bg-[#3a3a3c]"
                    : "bg-[#e5e5ea] text-[#1d1d1f] hover:bg-[#d2d2d7]"
                }`}
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
