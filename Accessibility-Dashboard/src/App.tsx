import { Suspense, lazy, useLayoutEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import {
  ErrorBoundary,
  isLazyChunkLoadError
} from "@/components/shared/error-boundary";

const LandingRoute = lazy(() =>
  import("@/components/ui/hero-demo").then((module) => ({ default: module.HeroDemo }))
);
const DashboardRoute = lazy(() =>
  import("@/components/dashboard/dashboard-app-route").then((module) => ({
    default: module.DashboardAppRoute
  }))
);
const DashboardPreviewRoute = lazy(() =>
  import("@/components/dashboard/dashboard-product-preview").then((module) => ({
    default: module.DashboardProductPreview
  }))
);

function AppRouteFallback() {
  return (
    <section
      className="fixed inset-0 z-[999] flex items-center justify-center bg-white"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
    >
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-lg">
        <p className="text-sm font-medium text-slate-700">분석 화면을 불러오는 중...</p>
      </div>
    </section>
  );
}

function getInitialDocumentTitle(pathname: string): string {
  if (pathname === "/") {
    return "UNI ACCESS | 웹 접근성 결과를 명확하게";
  }
  if (pathname === "/product-preview") {
    return "UNI ACCESS 제품 미리보기";
  }
  if (pathname.startsWith("/projects/")) {
    return "프로젝트 | UNI ACCESS";
  }
  if (pathname.startsWith("/recent-pages/")) {
    return "페이지 분석 결과 | UNI ACCESS";
  }
  return "새 페이지 분석 | UNI ACCESS";
}

function AppErrorFallback({
  error,
  resetErrorBoundary
}: {
  error: Error;
  resetErrorBoundary: () => void;
}) {
  const isChunkError = isLazyChunkLoadError(error);

  return (
    <main className="dashboard-modal-layer">
      <section
        role="alert"
        aria-labelledby="app-error-title"
        className="dashboard-modal-surface dashboard-modal-content w-full max-w-md"
      >
        <h1 id="app-error-title" className="dashboard-modal-title">
          앱 화면을 표시할 수 없습니다
        </h1>
        <p className="dashboard-modal-description mt-2">
          {isChunkError
            ? "필요한 화면 파일을 불러오지 못했습니다. 네트워크를 확인한 뒤 페이지를 새로고침해 주세요."
            : "예기치 않은 문제가 발생했습니다. 다시 시도하거나 페이지를 새로고침해 주세요."}
        </p>
        <div className="dashboard-modal-actions">
          {!isChunkError ? (
            <button
              type="button"
              onClick={resetErrorBoundary}
              className="dashboard-modal-button"
            >
              다시 시도
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="dashboard-modal-button dashboard-modal-button--primary"
          >
            페이지 새로고침
          </button>
        </div>
      </section>
    </main>
  );
}

function App() {
  const location = useLocation();

  useLayoutEffect(() => {
    document.title = getInitialDocumentTitle(location.pathname);
  }, [location.pathname]);

  return (
    <ErrorBoundary resetKey={location.pathname} fallback={AppErrorFallback}>
      <Suspense fallback={<AppRouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingRoute />} />
          <Route path="/product-preview" element={<DashboardPreviewRoute />} />
          <Route path="/analyze" element={<DashboardRoute />} />
          <Route path="/projects/:projectId" element={<DashboardRoute />} />
          <Route path="/projects/:projectId/pages/:pageId" element={<DashboardRoute />} />
          <Route path="/recent-pages/:pageId" element={<DashboardRoute />} />
          <Route path="/dashboard" element={<Navigate to="/analyze" replace />} />
          <Route path="*" element={<Navigate to="/analyze" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export default App;
