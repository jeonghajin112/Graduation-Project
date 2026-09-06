import { SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import { ChevronDown, ChevronRight, CircleAlert, LogOut, RotateCcw, Settings } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from "react";

import {
  ErrorBoundary,
  isLazyChunkLoadError
} from "@/components/shared/error-boundary";
import type { QuickAnalysisResultRecord } from "@/services/quick-analysis-registry";

import { useDashboardController } from "./shared/use-dashboard-controller";
import type { SiteDashboardPreviewEvidence } from "./panels/site-dashboard-panel";
import { ModalErrorFallback, ModalLoadFallback } from "./shared/modal-load-fallback";
import type { SidebarDemoProps } from "./shared/types";
import { SidebarProjectsSection } from "./sidebar-projects";

const QuickAnalyzePanel = lazy(() =>
  import("./panels/quick-analyze-panel").then((module) => ({ default: module.QuickAnalyzePanel }))
);
const OrganizationModelDetailPanel = lazy(() =>
  import("./panels/project-detail-panel").then((module) => ({ default: module.OrganizationModelDetailPanel }))
);
const SiteDashboardPanel = lazy(() =>
  import("./panels/site-dashboard-panel").then((module) => ({ default: module.SiteDashboardPanel }))
);
const AccountSettingsModal = lazy(() =>
  import("./modals/account-settings-modal").then((module) => ({ default: module.AccountSettingsModal }))
);
const OrganizationModelCreateModal = lazy(() =>
  import("./modals/organization-model-create-modal").then((module) => ({
    default: module.OrganizationModelCreateModal
  }))
);
const SiteCreateModal = lazy(() =>
  import("./modals/site-create-modal").then((module) => ({ default: module.SiteCreateModal }))
);
const ACCOUNT_MENU_ITEM_COUNT = 2;

function RoutePanelFallback() {
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

function RoutePanelErrorFallback({
  error,
  resetErrorBoundary
}: {
  error: Error;
  resetErrorBoundary: () => void;
}) {
  const isChunkError = isLazyChunkLoadError(error);

  return (
    <article
      role="alert"
      aria-labelledby="route-panel-error-title"
      className="rounded-[28px] border border-rose-200 bg-rose-50 p-5 text-sm"
    >
      <h2 id="route-panel-error-title" className="font-bold text-rose-800">
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

export type DashboardController = ReturnType<typeof useDashboardController>;

export function SidebarDemo({ onLogout, userName, onBootstrapComplete }: SidebarDemoProps) {
  const dashboard = useDashboardController({ onBootstrapComplete });

  return <DashboardSurface dashboard={dashboard} onLogout={onLogout} userName={userName} />;
}

export function DashboardSurface({
  dashboard,
  isPreview = false,
  onLogout,
  previewEvidenceByTargetId,
  previewQuickAnalysisResults,
  userName
}: {
  dashboard: DashboardController;
  isPreview?: boolean;
  onLogout?: () => void;
  previewEvidenceByTargetId?: ReadonlyMap<number, SiteDashboardPreviewEvidence>;
  previewQuickAnalysisResults?: readonly QuickAnalysisResultRecord[];
  userName: string;
}) {
  const mainContentRef = useRef<HTMLElement>(null);
  const isProjectDetailView =
    dashboard.menu === "projects" && Boolean(dashboard.selectedOrganizationModel) && !dashboard.selectedEvaluationTargetModel;
  const isSiteDetailView =
    dashboard.menu === "projects" && Boolean(dashboard.selectedOrganizationModel) && Boolean(dashboard.selectedEvaluationTargetModel);
  // Page detail currently starts directly with its evidence card. Keep only the
  // project title in the visual header until the page-detail header is redesigned.
  const hasCompactTopZone = !isProjectDetailView;
  const routePanelKey = `${dashboard.menu}:${dashboard.selectedOrganizationModel?.id ?? "none"}:${
    dashboard.selectedEvaluationTargetModel?.id ?? "none"
  }`;
  const selectedOrganizationName = dashboard.selectedOrganizationModel?.name ?? "";
  const selectedEvaluationTargetName = dashboard.selectedEvaluationTargetModel?.name ?? "";
  const mainContentId = isPreview ? "dashboard-product-preview-main" : "dashboard-main-content";

  const accountMenuId = useId();
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const accountMenuInitialFocusIndexRef = useRef(0);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);

  useEffect(() => {
    if (isPreview) {
      return;
    }

    const pageLabel = selectedEvaluationTargetName.length > 0
      ? `${selectedEvaluationTargetName} 접근성 분석`
      : selectedOrganizationName.length > 0
        ? `${selectedOrganizationName} 프로젝트`
        : dashboard.menu === "projects"
          ? "프로젝트"
          : "새 페이지 분석";
    document.title = `${pageLabel} | UNI ACCESS`;
  }, [
    dashboard.menu,
    isPreview,
    selectedEvaluationTargetName,
    selectedOrganizationName
  ]);

  const openAccountMenu = useCallback((initialFocusIndex = 0) => {
    accountMenuInitialFocusIndexRef.current = initialFocusIndex;
    setIsAccountMenuOpen(true);
  }, []);

  const closeAccountMenu = useCallback((restoreFocus = false) => {
    setIsAccountMenuOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => {
        accountTriggerRef.current?.focus({ preventScroll: true });
      }, 0);
    }
  }, []);

  const openAccountSettings = useCallback(() => {
    setIsAccountMenuOpen(false);
    accountTriggerRef.current?.focus({ preventScroll: true });
    setIsAccountSettingsOpen(true);
  }, []);

  const closeAccountSettings = useCallback(() => {
    setIsAccountSettingsOpen(false);
  }, []);

  const handleDashboardRetry = useCallback(async () => {
    const refreshedData = await dashboard.refreshDashboard();
    if (refreshedData !== null) {
      mainContentRef.current?.focus({ preventScroll: true });
    }
  }, [dashboard.refreshDashboard]);

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      accountMenuItemRefs.current[accountMenuInitialFocusIndexRef.current]?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [isAccountMenuOpen]);

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (accountTriggerRef.current?.contains(target) || accountMenuRef.current?.contains(target)) {
        return;
      }
      closeAccountMenu(true);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAccountMenu(true);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeAccountMenu, isAccountMenuOpen]);

  const handleAccountTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAccountMenu(0);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      openAccountMenu(ACCOUNT_MENU_ITEM_COUNT - 1);
    }
  };

  const handleAccountMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = accountMenuItemRefs.current.findIndex((item) => item === document.activeElement);
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % ACCOUNT_MENU_ITEM_COUNT;
    } else if (event.key === "ArrowUp") {
      nextIndex =
        currentIndex < 0
          ? ACCOUNT_MENU_ITEM_COUNT - 1
          : (currentIndex - 1 + ACCOUNT_MENU_ITEM_COUNT) % ACCOUNT_MENU_ITEM_COUNT;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = ACCOUNT_MENU_ITEM_COUNT - 1;
    } else if (event.key === "Tab") {
      closeAccountMenu();
      return;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      accountMenuItemRefs.current[nextIndex]?.focus({ preventScroll: true });
    }
  };

  return (
    <div
      className={`bridge-dashboard ${hasCompactTopZone ? "dashboard-compact-top" : ""} ${
        isProjectDetailView ? "dashboard-project-detail" : ""
      } ${
        isSiteDetailView ? "dashboard-site-detail" : ""
      } min-h-[100dvh] w-full overflow-x-hidden p-0 ${
        dashboard.isDarkMode ? "" : "bg-white"
      } ${dashboard.isDarkMode ? "theme-dark" : "theme-light"} ${
        isPreview ? "dashboard-embedded-preview" : ""
      }`}
      data-dashboard-product-preview={isPreview ? "true" : undefined}
    >
      <a className="dashboard-skip-link" href={`#${mainContentId}`}>
        본문으로 바로가기
      </a>
      <div className="dashboard-shell flex min-h-[100dvh] w-full flex-col bg-transparent md:flex-row">
        <SidebarBody className="reference-sidebar-body justify-start gap-0">
          <div className="dashboard-header-account reference-sidebar-account relative z-30 shrink-0 p-0">
            <button
              ref={accountTriggerRef}
              type="button"
              className="dashboard-account-menu-trigger w-fit max-w-full rounded-lg text-left outline-none transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-[var(--dashboard-accent)]/60 focus-visible:ring-offset-2"
              aria-expanded={isAccountMenuOpen}
              aria-controls={accountMenuId}
              aria-haspopup="menu"
              onClick={() => {
                if (isAccountMenuOpen) {
                  closeAccountMenu(true);
                  return;
                }
                openAccountMenu(0);
              }}
              onKeyDown={handleAccountTriggerKeyDown}
            >
              <span className="dashboard-account-avatar" aria-hidden="true">
                {userName.slice(0, 1)}
              </span>
              <span className="dashboard-account-name max-w-36 truncate font-bold">
                {userName}
              </span>
              <ChevronDown
                size={16}
                aria-hidden="true"
                className={`dashboard-account-menu-chevron transition-transform duration-150 ease-out ${
                  isAccountMenuOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {isAccountMenuOpen ? (
              <div
                ref={accountMenuRef}
                id={accountMenuId}
                role="menu"
                aria-label="계정 메뉴"
                onKeyDown={handleAccountMenuKeyDown}
                className="dashboard-account-menu dashboard-account-menu-open absolute left-0 right-auto top-full z-40 mt-1.5 origin-top rounded-2xl bg-white p-1.5 shadow-lg"
              >
                <button
                  ref={(element) => {
                    accountMenuItemRefs.current[0] = element;
                  }}
                  type="button"
                  role="menuitem"
                  className="dashboard-account-menu-item flex w-full items-center rounded-lg text-left font-medium text-slate-700 outline-none transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-[var(--dashboard-accent)]/60 focus-visible:ring-inset"
                  onClick={openAccountSettings}
                >
                  <Settings size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
                  설정
                </button>
                <button
                  ref={(element) => {
                    accountMenuItemRefs.current[1] = element;
                  }}
                  type="button"
                  role="menuitem"
                  aria-disabled={isPreview}
                  title={isPreview ? "읽기 전용 미리보기에서는 로그아웃할 수 없습니다" : undefined}
                  className={`dashboard-account-menu-item flex w-full items-center rounded-lg text-left font-medium text-slate-700 outline-none transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-[var(--dashboard-accent)]/60 focus-visible:ring-inset ${
                    isPreview ? "cursor-not-allowed" : ""
                  }`}
                  onClick={() => {
                    if (isPreview) {
                      return;
                    }
                    closeAccountMenu();
                    onLogout?.();
                  }}
                >
                  <LogOut size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
                  로그아웃
                </button>
              </div>
            ) : null}
          </div>

          <div className="reference-sidebar-content flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
            <div className="reference-sidebar-primary flex flex-col gap-1">
              {dashboard.sidebarLinks.map((link) => (
                <SidebarLink key={link.label} link={link} />
              ))}
            </div>

            <SidebarProjectsSection
              organizations={dashboard.organizations}
              evaluationRequests={isPreview ? undefined : dashboard.dashboardData?.evaluationRequests}
              selection={dashboard.sidebarSelection}
              onSelectProject={dashboard.goToProject}
              onSelectRecentPage={dashboard.goToRecentPage}
              onCreateProject={dashboard.openOrganizationCreateModal}
              onUpdateProject={dashboard.handleUpdateOrganizationModel}
              onDeleteProject={dashboard.handleDeleteOrganizationModel}
              onSelectPage={({ pageId }) => dashboard.goToSite(pageId)}
              quickAnalysisResultsOverride={previewQuickAnalysisResults}
              readOnly={isPreview}
            />
          </div>
        </SidebarBody>

        <main
          ref={mainContentRef}
          id={mainContentId}
          tabIndex={-1}
          className={`min-w-0 flex-1 overflow-visible ${
            dashboard.menu === "analyze" ? "dashboard-analyze-view" : ""
          }`}
        >
          <div className="dashboard-top-zone relative px-4 sm:px-7 lg:px-10">
            <header className="dashboard-fixed-header absolute top-4 right-4 left-4 z-30 flex items-start justify-end gap-5 sm:top-7 sm:right-7 sm:left-7 lg:top-10 lg:right-10 lg:left-10">
              {isProjectDetailView && (
                <div className="dashboard-project-header-content pointer-events-auto absolute top-[calc(var(--dashboard-control-size)-2.25rem)] flex min-w-0 items-start justify-between gap-6">
                  <div className="min-w-0">
                    <nav
                      aria-label="프로젝트 경로"
                      className={`dashboard-project-breadcrumb mb-1 flex items-center overflow-visible gap-0.5 font-semibold ${
                        dashboard.isDarkMode ? "text-[#8e8e93]" : "text-[#86868b]"
                      }`}
                    >
                      <span className="dashboard-project-breadcrumb-label inline-flex items-center">프로젝트</span>
                      <ChevronRight
                        className="dashboard-project-breadcrumb-chevron block shrink-0"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </nav>
                    <h1 className="dashboard-home-title dashboard-project-title shrink-0 font-black tracking-tight text-slate-900">
                      {dashboard.headerTitle}
                    </h1>
                  </div>
                </div>
              )}

            </header>

          </div>

          <div
            className={`dashboard-content-zone px-4 py-3 sm:px-7 sm:py-4 lg:px-10 lg:py-4 ${
              isSiteDetailView ? "dashboard-site-content-zone" : ""
            }`}
          >
            {dashboard.menu === "analyze" || isSiteDetailView ? (
              <h1 className="sr-only">{dashboard.headerTitle}</h1>
            ) : null}
            {dashboard.dashboardError.length > 0 ? (
              <article
                role="alert"
                aria-busy={dashboard.isDashboardLoading}
                className="mb-4 flex flex-col items-start gap-3 rounded-[28px] border border-rose-200 bg-rose-50 p-5 text-sm"
              >
                <p className="flex items-center gap-2 font-semibold text-rose-700">
                  <CircleAlert className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                  대시보드를 불러오지 못했습니다
                </p>
                <p className="text-rose-600">{dashboard.dashboardError}</p>
                <button
                  type="button"
                  disabled={dashboard.isDashboardLoading}
                  onClick={() => void handleDashboardRetry()}
                  className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-wait disabled:opacity-60"
                >
                  <RotateCcw size={13} strokeWidth={2.4} aria-hidden="true" />
                  {dashboard.isDashboardLoading
                    ? "대시보드 불러오는 중"
                    : "대시보드 다시 불러오기"}
                </button>
              </article>
            ) : null}

            <ErrorBoundary resetKey={routePanelKey} fallback={RoutePanelErrorFallback}>
              <Suspense fallback={<RoutePanelFallback />}>
                {dashboard.menu === "analyze" && (
                  <QuickAnalyzePanel
                    isDarkMode={dashboard.isDarkMode}
                  onAnalysisAccepted={dashboard.handleQuickAnalysisAccepted}
                    readOnly={isPreview}
                  />
                )}

                {dashboard.menu === "projects" && dashboard.selectedOrganizationModel && dashboard.selectedEvaluationTargetModel && (
                  <SiteDashboardPanel
                    onRequestEvaluationTargetAnalysis={isPreview ? undefined : dashboard.handleRequestEvaluationTargetAnalysis}
                    onAnalysisAccepted={isPreview ? undefined : dashboard.handleAnalysisAccepted}
                    evaluationTarget={dashboard.selectedEvaluationTargetModel}
                    evaluationRequests={dashboard.dashboardData?.evaluationRequests ?? []}
                    resultSummaries={dashboard.dashboardData?.resultSummaries ?? []}
                    scoreResults={dashboard.dashboardData?.scoreResults ?? []}
                    previewEvidence={previewEvidenceByTargetId?.get(
                      dashboard.selectedEvaluationTargetModel.id
                    )}
                  />
                )}

                {dashboard.menu === "projects" &&
                  dashboard.selectedOrganizationModel &&
                  !dashboard.selectedEvaluationTargetModel && (
                    <OrganizationModelDetailPanel
                      organization={dashboard.selectedOrganizationModel}
                      evaluationRequests={dashboard.dashboardData?.evaluationRequests ?? []}
                      scoreResults={dashboard.dashboardData?.scoreResults ?? []}
                      isDarkMode={dashboard.isDarkMode}
                      onDeleteEvaluationTargetModel={dashboard.handleDeleteEvaluationTargetModel}
                      onOpenCreateSiteModal={dashboard.openSiteCreateModal}
                      onSiteClick={dashboard.goToSite}
                      readOnly={isPreview}
                    />
                  )}
              </Suspense>
            </ErrorBoundary>
          </div>

          {!isPreview && dashboard.selectedOrganizationModel && dashboard.isSiteCreateOpen && (
            <ErrorBoundary
              resetKey={`site-create:${dashboard.selectedOrganizationModel.id}`}
              fallback={({ error, resetErrorBoundary }) => (
                <ModalErrorFallback
                  isChunkError={isLazyChunkLoadError(error)}
                  onDismiss={() => dashboard.setIsSiteCreateOpen(false)}
                  onRetry={resetErrorBoundary}
                  onReload={() => window.location.reload()}
                />
              )}
            >
              <Suspense fallback={<ModalLoadFallback />}>
                <SiteCreateModal
                  key={dashboard.selectedOrganizationModel.id}
                  isOpen
                  isDarkMode={dashboard.isDarkMode}
                  project={dashboard.selectedOrganizationModel}
                  onCreateEvaluationTargetModel={dashboard.handleCreateEvaluationTargetModel}
                  onRequestEvaluationTargetAnalysis={dashboard.handleRequestEvaluationTargetAnalysis}
              onAnalysisAccepted={dashboard.handleAnalysisAccepted}
                  onClose={() => dashboard.setIsSiteCreateOpen(false)}
                />
              </Suspense>
            </ErrorBoundary>
          )}

          {!isPreview && dashboard.isOrganizationCreateOpen && (
            <ErrorBoundary
              resetKey="organization-create"
              fallback={({ error, resetErrorBoundary }) => (
                <ModalErrorFallback
                  isChunkError={isLazyChunkLoadError(error)}
                  onDismiss={() => dashboard.setIsOrganizationCreateOpen(false)}
                  onRetry={resetErrorBoundary}
                  onReload={() => window.location.reload()}
                />
              )}
            >
              <Suspense fallback={<ModalLoadFallback />}>
                <OrganizationModelCreateModal
                  isOpen
                  name={dashboard.newOrganizationModelName}
                  isSubmitting={dashboard.isCreatingOrganizationModel}
                  hasPendingOrganizationCreate={dashboard.hasPendingOrganizationCreate}
                  canDiscardRecovery={dashboard.canDiscardOrganizationCreateRecovery}
                  isRecoveryBlocked={dashboard.isOrganizationCreateRecoveryBlocked}
                  errorMessage={dashboard.projectCreateError}
                  onNameChange={dashboard.setNewOrganizationModelName}
                  onClose={() => {
                    if (dashboard.isCreatingOrganizationModel) {
                      return;
                    }
                    dashboard.setIsOrganizationCreateOpen(false);
                  }}
                  onSubmit={dashboard.handleCreateOrganizationModel}
                  onDiscardRecovery={dashboard.discardOrganizationCreateRecovery}
                />
              </Suspense>
            </ErrorBoundary>
          )}

          {isAccountSettingsOpen && (
            <ErrorBoundary
              resetKey="account-settings"
              fallback={({ error, resetErrorBoundary }) => (
                <ModalErrorFallback
                  isChunkError={isLazyChunkLoadError(error)}
                  onDismiss={closeAccountSettings}
                  onRetry={resetErrorBoundary}
                  onReload={() => window.location.reload()}
                />
              )}
            >
              <Suspense fallback={<ModalLoadFallback />}>
                <AccountSettingsModal
                  isOpen
                  themeMode={dashboard.themeMode}
                  onThemeModeChange={dashboard.setThemeMode}
                  onClose={closeAccountSettings}
                />
              </Suspense>
            </ErrorBoundary>
          )}

        </main>
      </div>
    </div>
  );
}
