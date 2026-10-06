import { SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  LogOut,
  PanelLeft,
  RotateCcw,
  Settings
} from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";

import {
  ErrorBoundary,
  isLazyChunkLoadError
} from "@/components/shared/error-boundary";

import { ModalErrorFallback, ModalLoadFallback } from "./shared/modal-load-fallback";
import { RoutePanelErrorFallback, RoutePanelFallback } from "./shared/route-panel-fallbacks";
import type { DashboardSurfaceProps } from "./dashboard-surface.types";
import { SidebarProjectsSection } from "./sidebar-projects";
import "@/styles/dashboard-a11y.css";

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
const ACCOUNT_MENU_ITEM_COUNT = 2;
const SIDEBAR_COLLAPSED_STORAGE_KEY = "dashboard-sidebar-collapsed";
// Matches the --dashboard-sidebar-width transition in index.css.
const SIDEBAR_SLIDE_MS = 280;

function readStoredSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function DashboardSurface(props: DashboardSurfaceProps) {
  const { dashboard, userName } = props;
  const isPreview = props.mode === "preview";
  const actions = props.mode === "live" ? props.actions : null;
  const previewEvidenceByTargetId = props.mode === "preview" ? props.previewEvidenceByTargetId : undefined;
  const previewQuickAnalysisResults = props.mode === "preview" ? props.previewQuickAnalysisResults : undefined;
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
  // The collapsed rail hides the labelled trigger; this avatar-only button keeps
  // settings and logout reachable without expanding the sidebar.
  const accountRailTriggerRef = useRef<HTMLButtonElement>(null);
  const accountMenuAnchorRef = useRef<"label" | "rail">("label");
  const [railMenuPosition, setRailMenuPosition] = useState<CSSProperties | null>(null);
  const routeHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const previousRouteKeyRef = useRef<string | null>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const accountMenuInitialFocusIndexRef = useRef(0);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);
  const sidebarContentId = useId();
  // The embedded landing preview always starts expanded and never writes the
  // viewer's dashboard preference.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => !isPreview && readStoredSidebarCollapsed());

  useEffect(() => {
    if (isPreview) {
      return;
    }
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
    } catch {
      // Collapsing must keep working for this session without storage.
    }
  }, [isPreview, isSidebarCollapsed]);

  const sidebarToggleLabel = isSidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기";

  // The rail slides only when the user toggles it; a window resize changes
  // its width at once, so layout never lags behind the viewport.
  const [isSidebarSliding, setIsSidebarSliding] = useState(false);
  useEffect(() => {
    if (!isSidebarSliding) {
      return;
    }
    const timer = window.setTimeout(() => setIsSidebarSliding(false), SIDEBAR_SLIDE_MS + 40);
    return () => window.clearTimeout(timer);
  }, [isSidebarSliding, isSidebarCollapsed]);

  const toggleSidebar = useCallback(() => {
    setIsAccountMenuOpen(false);
    setIsSidebarSliding(true);
    setIsSidebarCollapsed((collapsed) => !collapsed);
  }, []);

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

  // Move keyboard and screen-reader focus to the new view's heading after an
  // in-app navigation. The first settled route (initial load) is left alone so
  // the skip link stays the first Tab stop.
  const isRouteSettled = isPreview || dashboard.dashboardData !== null;
  useEffect(() => {
    if (isPreview || !isRouteSettled) {
      return;
    }
    const previousRouteKey = previousRouteKeyRef.current;
    previousRouteKeyRef.current = routePanelKey;
    if (previousRouteKey === null || previousRouteKey === routePanelKey) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => {
      if (document.querySelector('[aria-modal="true"]')) {
        return;
      }
      const target = routeHeadingRef.current ?? mainContentRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [isPreview, isRouteSettled, routePanelKey]);

  const getAccountTrigger = useCallback(
    () =>
      accountMenuAnchorRef.current === "rail"
        ? accountRailTriggerRef.current
        : accountTriggerRef.current,
    []
  );

  const openAccountMenu = useCallback((initialFocusIndex = 0, anchor: "label" | "rail" = "label") => {
    accountMenuInitialFocusIndexRef.current = initialFocusIndex;
    accountMenuAnchorRef.current = anchor;
    if (anchor === "rail") {
      const rect = accountRailTriggerRef.current?.getBoundingClientRect();
      const isMobileRail = window.innerWidth < 768;
      setRailMenuPosition(
        rect
          ? isMobileRail
            ? { position: "fixed", left: Math.max(8, rect.left), top: rect.bottom + 6 }
            : { position: "fixed", left: rect.right + 8, top: Math.max(8, rect.top) }
          : null
      );
    } else {
      setRailMenuPosition(null);
    }
    setIsAccountMenuOpen(true);
  }, []);

  const closeAccountMenu = useCallback((restoreFocus = false) => {
    setIsAccountMenuOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => {
        getAccountTrigger()?.focus({ preventScroll: true });
      }, 0);
    }
  }, [getAccountTrigger]);

  const openAccountSettings = useCallback(() => {
    setIsAccountMenuOpen(false);
    getAccountTrigger()?.focus({ preventScroll: true });
    setIsAccountSettingsOpen(true);
  }, [getAccountTrigger]);

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
      if (
        accountTriggerRef.current?.contains(target) ||
        accountRailTriggerRef.current?.contains(target) ||
        accountMenuRef.current?.contains(target)
      ) {
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

  const handleAccountTriggerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    anchor: "label" | "rail" = "label"
  ) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAccountMenu(0, anchor);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      openAccountMenu(ACCOUNT_MENU_ITEM_COUNT - 1, anchor);
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
      if (railMenuPosition) {
        // The rail menu lives outside the sidebar in DOM order; hand focus back
        // to its trigger instead of letting Tab jump to the top of the page.
        event.preventDefault();
        closeAccountMenu(true);
        return;
      }
      closeAccountMenu();
      return;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      accountMenuItemRefs.current[nextIndex]?.focus({ preventScroll: true });
    }
  };

  const isRailAccountMenu = isAccountMenuOpen && railMenuPosition !== null;
  const accountMenu = isAccountMenuOpen ? (
    <div
      ref={accountMenuRef}
      id={accountMenuId}
      role="menu"
      aria-label="계정 메뉴"
      onKeyDown={handleAccountMenuKeyDown}
      style={railMenuPosition ?? undefined}
      className={`dashboard-account-menu dashboard-account-menu-open z-40 origin-top rounded-2xl bg-white p-1.5 shadow-lg ${
        railMenuPosition ? "" : "absolute left-0 right-auto top-full mt-1.5"
      }`}
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
          if (props.mode === "live") props.onLogout?.();
        }}
      >
        <LogOut size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
        로그아웃
      </button>
    </div>
  ) : null;

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
        isSidebarSliding ? "dashboard-sidebar-is-sliding" : ""
      }`}
      data-dashboard-product-preview={isPreview ? "true" : undefined}
    >
      <a className="dashboard-skip-link" href={`#${mainContentId}`}>
        본문으로 바로가기
      </a>
      <div className="dashboard-shell flex min-h-[100dvh] w-full flex-col bg-transparent md:flex-row">
        {/* The rail is paint-contained, so its account menu is positioned from
            here (fixed) instead of being clipped inside the collapsed sidebar. */}
        {isRailAccountMenu ? accountMenu : null}
        <SidebarBody
          className={`reference-sidebar-body justify-start gap-0 ${
            isSidebarCollapsed ? "dashboard-sidebar-collapsed" : ""
          }`}
        >
          <div className="dashboard-header-account reference-sidebar-account relative z-30 flex shrink-0 items-center justify-between gap-1 p-0">
            <button
              ref={accountTriggerRef}
              type="button"
              className="dashboard-account-menu-trigger w-fit min-w-0 max-w-full rounded-lg text-left outline-none transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-[var(--dashboard-accent)]/60 focus-visible:ring-offset-2"
              aria-expanded={isAccountMenuOpen && !isRailAccountMenu}
              aria-controls={accountMenuId}
              aria-haspopup="menu"
              onClick={() => {
                if (isAccountMenuOpen) {
                  closeAccountMenu(true);
                  return;
                }
                openAccountMenu(0);
              }}
              onKeyDown={(event) => handleAccountTriggerKeyDown(event)}
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

            {isRailAccountMenu ? null : accountMenu}

            <button
              type="button"
              className="dashboard-sidebar-toggle inline-flex shrink-0 items-center justify-center"
              aria-label={sidebarToggleLabel}
              title={sidebarToggleLabel}
              aria-expanded={!isSidebarCollapsed}
              aria-controls={sidebarContentId}
              onClick={toggleSidebar}
            >
              <PanelLeft size={18} strokeWidth={2} aria-hidden="true" />
            </button>

            <button
              ref={accountRailTriggerRef}
              type="button"
              className="dashboard-account-rail-trigger"
              aria-label={`계정 메뉴 (${userName})`}
              title={userName}
              aria-expanded={isRailAccountMenu}
              aria-controls={accountMenuId}
              aria-haspopup="menu"
              onClick={() => {
                if (isAccountMenuOpen) {
                  closeAccountMenu(true);
                  return;
                }
                openAccountMenu(0, "rail");
              }}
              onKeyDown={(event) => handleAccountTriggerKeyDown(event, "rail")}
            >
              <span className="dashboard-account-avatar" aria-hidden="true">
                {userName.slice(0, 1)}
              </span>
            </button>
          </div>

          <div
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
                      className="dashboard-project-breadcrumb mb-1 flex items-center overflow-visible gap-0.5 font-semibold text-[var(--dashboard-text-muted)]"
                    >
                      <span className="dashboard-project-breadcrumb-label inline-flex items-center">프로젝트</span>
                      <ChevronRight
                        className="dashboard-project-breadcrumb-chevron block shrink-0"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </nav>
                    <h1
                      ref={routeHeadingRef}
                      tabIndex={-1}
                      className="dashboard-home-title dashboard-project-title shrink-0 font-black tracking-tight text-slate-900 focus:outline-none"
                    >
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
                    supportsIdempotency={dashboard.dashboardData?.analysisProtocolVersion === 1}
                    {...(actions
                      ? { onAnalysisAccepted: actions.handleQuickAnalysisAccepted }
                      : { readOnly: true })}
                  />
                )}

                {dashboard.menu === "projects" && dashboard.selectedOrganizationModel && dashboard.selectedEvaluationTargetModel && (
                  <SiteDashboardPanel
                    onRequestEvaluationTargetAnalysis={actions?.handleRequestEvaluationTargetAnalysis}
                    onAnalysisAccepted={actions?.handleAnalysisAccepted}
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
                      actions={actions ? {
                        onDeleteEvaluationTargetModel: actions.handleDeleteEvaluationTargetModel,
                        onOpenCreateSiteModal: actions.openSiteCreateModal
                      } : null}
                      onSiteClick={dashboard.goToSite}
                    />
                  )}
              </Suspense>
            </ErrorBoundary>
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
