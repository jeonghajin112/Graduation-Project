import { useId } from "react";

import { isLazyChunkLoadError } from "@/components/shared/error-boundary";

// Shared by lazily loaded dashboard route panels and the page detail report tab.
export function RoutePanelFallback() {
  return (
    <article
      className="dashboard-status-card"
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
      className="dashboard-status-card"
    >
      <h2 id={titleId} className="dashboard-status-card-title">
        화면을 표시할 수 없습니다
      </h2>
      <p>
        {isChunkError
          ? "필요한 화면 파일을 불러오지 못했습니다. 네트워크를 확인한 뒤 페이지를 새로고침해 주세요."
          : "화면을 표시하는 중 문제가 발생했습니다. 다시 시도하거나 페이지를 새로고침해 주세요."}
      </p>
      <div className="dashboard-status-card-actions">
        {!isChunkError ? (
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="dashboard-status-card-button dashboard-status-card-button--primary"
          >
            다시 시도
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="dashboard-status-card-button"
        >
          페이지 새로고침
        </button>
      </div>
    </article>
  );
}
