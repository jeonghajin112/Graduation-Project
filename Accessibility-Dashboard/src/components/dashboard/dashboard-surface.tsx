import { SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import {
  CircleAlert,
  Menu,
  PanelLeft,
  RotateCcw,
  X
} from "lucide-react";
import { Suspense, lazy, useCallback, useId, useRef, useState } from "react";

import {
  ErrorBoundary,
  isLazyChunkLoadError
} from "@/components/shared/error-boundary";

import { ModalErrorFallback, ModalLoadFallback } from "./shared/modal-load-fallback";
import { AccountMenu, AccountMenuTrigger, AccountRailTrigger, useAccountMenu } from "./dashboard-account-menu";
import { DashboardRoutePanels } from "./dashboard-route-panels";
import {
  useDashboardDocumentTitle,
  useMobileSidebarDrawer,
  useRouteHeadingFocus,
  useSidebarCollapse
} from "./dashboard-surface-hooks";
import { PROJECT_HEADER_ACTIONS_ID, type DashboardSurfaceProps } from "./dashboard-surface.types";
import { SidebarProjectsSection } from "./sidebar-projects";
import "@/styles/dashboard-a11y.css";

const AccountSettingsModal = lazy(() =>
  import("./modals/account-settings-modal").then((module) => ({ default: module.AccountSettingsModal }))
);

export function DashboardSurface(props: DashboardSurfaceProps) {
  const { dashboard, userName } = props;
  const isPreview = props.mode === "preview";
  const actions = props.mode === "live" ? props.actions : null;
  const previewEvidenceByTargetId = props.mode === "preview" ? props.previewEvidenceByTargetId : undefined;
  const previewQuickAnalysisResults = props.mode === "preview" ? props.previewQuickAnalysisResults : undefined;
  const mainContentRef = useRef<HTMLElement>(null);
  const routeHeadingRef = useRef<HTMLHeadingElement | null>(null);
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
  const mainContentId = isPreview ? "dashboard-product-preview-main" : "dashboard-main-content";
  const sidebarContentId = useId();

  const accountMenu = useAccountMenu();
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);
  const sidebar = useSidebarCollapse(isPreview, accountMenu.close);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const drawer = useMobileSidebarDrawer({
    routeKey: routePanelKey,
    toggleRef: sidebarToggleRef,
    drawerRef: sidebarContentRef,
    mainRef: mainContentRef
  });
  // Phones use the drawer; the desktop rail preference is kept but not applied.
  const isSidebarCollapsed = sidebar.isCollapsed && !drawer.isMobile;
  const sidebarToggleLabel = drawer.isMobile
    ? drawer.isOpen ? "메뉴 닫기" : "메뉴 열기"
    : isSidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기";
  const { close: closeAccountMenu } = accountMenu;
  const { isMobile: isMobileSidebar, toggle: toggleDrawer } = drawer;
  const { toggle: toggleRail } = sidebar;
  const handleSidebarToggle = useCallback(() => {
    if (isMobileSidebar) {
      closeAccountMenu();
      toggleDrawer();
    } else {
      toggleRail();
    }
  }, [closeAccountMenu, isMobileSidebar, toggleDrawer, toggleRail]);

  useDashboardDocumentTitle(
    isPreview,
    dashboard.menu,
    dashboard.selectedOrganizationModel?.name ?? "",
    dashboard.selectedEvaluationTargetModel?.name ?? ""
  );
  useRouteHeadingFocus({
    enabled: !isPreview && dashboard.dashboardData !== null,
    routeKey: routePanelKey,
    headingRef: routeHeadingRef,
    fallbackRef: mainContentRef
  });

  const { closeBeforeDialog } = accountMenu;
  const openAccountSettings = useCallback(() => {
    closeBeforeDialog();
    setIsAccountSettingsOpen(true);
  }, [closeBeforeDialog]);

  const closeAccountSettings = useCallback(() => {
    setIsAccountSettingsOpen(false);
  }, []);

  const handleDashboardRetry = useCallback(async () => {
    if (!actions) return;
    const refreshedData = await actions.refreshDashboard();
    if (refreshedData !== null) {
      mainContentRef.current?.focus({ preventScroll: true });
    }
  }, [actions]);

  const accountMenuPopup = (
    <AccountMenu
      menu={accountMenu}
      isPreview={isPreview}
      onOpenSettings={openAccountSettings}
      onLogout={props.mode === "live" ? props.onLogout : undefined}
    />
  );

  return (
    <div
      className={`bridge-dashboard ${hasCompactTopZone ? "dashboard-compact-top" : ""} ${
        isProjectDetailView ? "dashboard-project-detail" : ""
      } ${
        isSiteDetailView ? "dashboard-site-detail" : ""
      } min-h-[100dvh] w-full overflow-x-clip p-0 ${
        dashboard.isDarkMode ? "" : "bg-white"
      } ${dashboard.isDarkMode ? "theme-dark" : "theme-light"} ${
        isPreview ? "dashboard-embedded-preview" : ""
      } ${isSidebarCollapsed ? "dashboard-sidebar-is-collapsed" : ""} ${
        sidebar.isSliding ? "dashboard-sidebar-is-sliding" : ""
      } ${drawer.isOpen ? "dashboard-mobile-drawer-open" : ""}`}
      data-dashboard-product-preview={isPreview ? "true" : undefined}
    >
      <a className="dashboard-skip-link" href={`#${mainContentId}`}>
        본문으로 바로가기
      </a>
      <div className="dashboard-shell flex min-h-[100dvh] w-full flex-col bg-transparent md:flex-row">
        {/* The rail is paint-contained, so its account menu is positioned from
            here (fixed) instead of being clipped inside the collapsed sidebar. */}
        {accountMenu.isRailMenu ? accountMenuPopup : null}
        <SidebarBody
          className={`reference-sidebar-body justify-start gap-0 ${
            isSidebarCollapsed ? "dashboard-sidebar-collapsed" : ""
          }`}
        >
          <div className="dashboard-header-account reference-sidebar-account relative z-30 flex shrink-0 items-center justify-between gap-1 p-0">
            <AccountMenuTrigger menu={accountMenu} userName={userName} />

            {accountMenu.isRailMenu ? null : accountMenuPopup}

            <button
              ref={sidebarToggleRef}
              type="button"
              className="dashboard-sidebar-toggle inline-flex shrink-0 items-center justify-center"
              aria-label={sidebarToggleLabel}
              title={sidebarToggleLabel}
              aria-expanded={drawer.isMobile ? drawer.isOpen : !isSidebarCollapsed}
              aria-controls={sidebarContentId}
              onClick={handleSidebarToggle}
            >
              {drawer.isMobile ? (
                drawer.isOpen ? (
                  <X size={20} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <Menu size={20} strokeWidth={2} aria-hidden="true" />
                )
              ) : (
                <PanelLeft size={18} strokeWidth={2} aria-hidden="true" />
              )}
            </button>

            <AccountRailTrigger menu={accountMenu} userName={userName} />
          </div>

          <div
            ref={sidebarContentRef}
            id={sidebarContentId}
            className="reference-sidebar-content flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden"
          >
            <div className="reference-sidebar-primary flex flex-col gap-1">
              {dashboard.sidebarLinks.map((link) => (
                <SidebarLink key={link.label} link={link} title={isSidebarCollapsed ? link.label : undefined} />
              ))}
            </div>

            <SidebarProjectsSection
              organizations={dashboard.organizations}
              evaluationRequests={isPreview ? undefined : dashboard.dashboardData?.evaluationRequests}
              selection={dashboard.sidebarSelection}
              onSelectProject={dashboard.goToProject}
              onSelectRecentPage={dashboard.goToRecentPage}
              actions={actions ? {
                onCreateProject: actions.openOrganizationCreateModal,
                onUpdateProject: actions.handleUpdateOrganizationModel,
                onDeleteProject: actions.handleDeleteOrganizationModel,
                onDeletePage: actions.handleDeleteEvaluationTargetModel
              } : null}
              onSelectPage={({ pageId }) => dashboard.goToSite(pageId)}
              quickAnalysisResultsOverride={previewQuickAnalysisResults}
              listState={
                isPreview || dashboard.dashboardData
                  ? "ready"
                  : dashboard.dashboardError.length > 0
                    ? "error"
                    : "loading"
              }
            />
          </div>
          {drawer.isOpen ? (
            <div
              className="dashboard-mobile-drawer-backdrop"
              aria-hidden="true"
              onClick={() => drawer.close(true)}
            />
          ) : null}
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
                    <p className="dashboard-project-eyebrow mb-1 font-semibold text-[var(--dashboard-text-muted)]">
                      프로젝트
                    </p>
                    <h1
                      ref={routeHeadingRef}
                      tabIndex={-1}
                      className="dashboard-home-title dashboard-project-title shrink-0 font-black tracking-tight text-[var(--dashboard-text-strong)] focus:outline-none"
                    >
                      {dashboard.headerTitle}
                    </h1>
                  </div>
                  <div id={PROJECT_HEADER_ACTIONS_ID} className="dashboard-project-header-actions" />
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
              <h1 ref={routeHeadingRef} tabIndex={-1} className="sr-only">
                {dashboard.headerTitle}
              </h1>
            ) : null}
            {(dashboard.pausedStatusCount ?? 0) > 0 && <div className="site-result-notice" role="status">
              {dashboard.pausedStatusCount}개 분석의 상태를 계속 확인하지 못해 자동 조회를 잠시 중지했습니다. 분석 실패나 삭제가 확정된 것은 아닙니다.
              <button type="button" className="dashboard-modal-button" onClick={dashboard.retryStatusChecks}>분석 상태 다시 확인</button>
            </div>}
            {dashboard.dashboardError.length > 0 ? (
              <article
                role="alert"
                aria-busy={dashboard.isDashboardLoading}
                className="dashboard-status-card mb-4"
              >
                <p className="dashboard-status-card-title">
                  <CircleAlert className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                  대시보드를 불러오지 못했습니다
                </p>
                <p>{dashboard.dashboardError}</p>
                <button
                  type="button"
                  disabled={dashboard.isDashboardLoading}
                  onClick={() => void handleDashboardRetry()}
                  className="dashboard-status-card-button dashboard-status-card-button--primary"
                >
                  <RotateCcw size={13} strokeWidth={2.4} aria-hidden="true" />
                  {dashboard.isDashboardLoading
                    ? "대시보드 불러오는 중"
                    : "대시보드 다시 불러오기"}
                </button>
              </article>
            ) : null}

            <DashboardRoutePanels
              dashboard={dashboard}
              actions={actions}
              routeKey={routePanelKey}
              previewEvidenceByTargetId={previewEvidenceByTargetId}
            />
          </div>

          {props.mode === "live" ? props.mutationModals : null}

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
