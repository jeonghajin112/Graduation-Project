import { useId } from "react";

import { isLazyChunkLoadError } from "@/components/shared/error-boundary";

// Shared by lazily loaded dashboard route panels and the page detail report tab.
export function RoutePanelFallback() {
  return (
    <article
      className="rounded-[28px] border border-slate-200 bg-white p-5 text-sm text-slate-600"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
    >
      화면을 불러오는 중...
    </article>
  );
}

export function RoutePanelErrorFallback({
  error,
  resetErrorBoundary
}: {
  error: Error;
  resetErrorBoundary: () => void;
}) {
  const isChunkError = isLazyChunkLoadError(error);
  const titleId = useId();

  return (
    <article
      role="alert"
      aria-labelledby={titleId}
      className="rounded-[28px] border border-rose-200 bg-rose-50 p-5 text-sm"
    >
      <h2 id={titleId} className="font-bold text-rose-800">
        화면을 표시할 수 없습니다
      </h2>
      <p className="mt-2 leading-6 text-rose-700">
        {isChunkError
          ? "필요한 화면 파일을 불러오지 못했습니다. 네트워크를 확인한 뒤 페이지를 새로고침해 주세요."
          : "화면을 표시하는 중 문제가 발생했습니다. 다시 시도하거나 페이지를 새로고침해 주세요."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {!isChunkError ? (
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="rounded-lg bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            다시 시도
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-white px-4 py-2 text-xs font-bold text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          페이지 새로고침
        </button>
      </div>
    </article>
  );
}
