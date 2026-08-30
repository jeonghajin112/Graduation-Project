import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

function useModalLayerOwnership<TElement extends HTMLElement>() {
  const layerRef = useRef<TElement>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) {
      return;
    }

    const appShell = document.querySelector<HTMLElement>("[data-dashboard-app-shell]");
    const appShellWasInert = appShell?.inert ?? false;
    const previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;

    if (appShell) {
      appShell.inert = true;
    }
    document.body.style.overflow = "hidden";

    const focusFrame = window.requestAnimationFrame(() => {
      layer.focus({ preventScroll: true });
    });
    const keepFocusInLayer = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = Array.from(
        layer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getClientRects().length > 0);
      if (focusableElements.length === 0) {
        event.preventDefault();
        layer.focus({ preventScroll: true });
        return;
      }

      const firstElement = focusableElements[0]!;
      const lastElement = focusableElements[focusableElements.length - 1]!;
      const focusedElement = document.activeElement;
      if (!layer.contains(focusedElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus({ preventScroll: true });
      } else if (event.shiftKey && (focusedElement === firstElement || focusedElement === layer)) {
        event.preventDefault();
        lastElement.focus({ preventScroll: true });
      } else if (!event.shiftKey && focusedElement === lastElement) {
        event.preventDefault();
        firstElement.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", keepFocusInLayer);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", keepFocusInLayer);
      document.body.style.overflow = previousBodyOverflow;
      if (appShell) {
        appShell.inert = appShellWasInert;
      }

      if (
        previouslyFocusedElement &&
        document.contains(previouslyFocusedElement) &&
        (layer.contains(document.activeElement) || !document.contains(document.activeElement))
      ) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
    };
  }, []);

  return layerRef;
}

export function ModalLoadFallback() {
  const titleId = useId();
  const statusRef = useModalLayerOwnership<HTMLDivElement>();

  return createPortal(
    <section
      className="dashboard-modal-layer fixed inset-0 flex items-center justify-center bg-black/35 px-4 py-6 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-dashboard-modal-loading
    >
      <div
        ref={statusRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy="true"
        tabIndex={-1}
        className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <p id={titleId} className="text-sm font-medium text-slate-700">
          창을 불러오는 중...
        </p>
      </div>
    </section>,
    document.body
  );
}

export function ModalErrorFallback({
  isChunkError,
  onDismiss,
  onRetry,
  onReload
}: {
  isChunkError: boolean;
  onDismiss: () => void;
  onRetry: () => void;
  onReload: () => void;
}) {
  const titleId = useId();
  const dialogRef = useModalLayerOwnership<HTMLElement>();

  return createPortal(
    <div className="dashboard-modal-layer fixed inset-0 flex items-center justify-center bg-black/60 px-4 py-6">
      <article
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-md rounded-[18px] border border-rose-200 bg-white p-6 shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
      >
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">
          창을 표시할 수 없습니다
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {isChunkError
            ? "필요한 화면 파일을 불러오지 못했습니다. 네트워크를 확인한 뒤 페이지를 새로고침해 주세요."
            : "화면을 표시하는 중 문제가 발생했습니다. 다시 시도하거나 페이지를 새로고침해 주세요."}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            닫기
          </button>
          {!isChunkError ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              다시 시도
            </button>
          ) : null}
          <button
            type="button"
            onClick={onReload}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            페이지 새로고침
          </button>
        </div>
      </article>
    </div>,
    document.body
  );
}
