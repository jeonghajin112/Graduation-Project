import { Sidebar, SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import { ChevronDown, ChevronRight, LogOut, Settings } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from "react";

import { AccountSettingsModal } from "./modals/account-settings-modal";
import { OrganizationModelCreateModal } from "./modals/organization-model-create-modal";
import { SiteCreateModal } from "./modals/site-create-modal";
import { useDashboardController } from "./shared/use-dashboard-controller";
import type { SidebarDemoProps } from "./shared/types";
import { SidebarProjectsSection } from "./sidebar-projects";

const QuickAnalyzePanel = lazy(() =>
  import("./panels/quick-analyze-panel").then((module) => ({ default: module.QuickAnalyzePanel }))
);
const DashboardPanel = lazy(() =>
  import("./panels/dashboard-panel").then((module) => ({ default: module.DashboardPanel }))
);
const OrganizationModelDetailPanel = lazy(() =>
  import("./panels/project-detail-panel").then((module) => ({ default: module.OrganizationModelDetailPanel }))
);
const SiteDashboardPanel = lazy(() =>
  import("./panels/site-dashboard-panel").then((module) => ({ default: module.SiteDashboardPanel }))
);
const ACCOUNT_MENU_ITEM_COUNT = 2;

function RoutePanelFallback() {
  return (
    <article className="rounded-[28px] border border-slate-200 bg-white p-5 text-sm text-slate-600">
      화면을 불러오는 중...
    </article>
  );
}

export function SidebarDemo({ onLogout, userName, onBootstrapComplete }: SidebarDemoProps) {
  const dashboard = useDashboardController({ onBootstrapComplete });
  const isProjectDetailView =
    dashboard.menu === "projects" && Boolean(dashboard.selectedOrganizationModel) && !dashboard.selectedEvaluationTargetModel;
  const isSiteDetailView =
    dashboard.menu === "projects" && Boolean(dashboard.selectedOrganizationModel) && Boolean(dashboard.selectedEvaluationTargetModel);
  // Analyze home has no large page title — keep top/content zones clean white.
  const shouldShowHeaderTitle = isProjectDetailView;
  const hasCompactTopZone = !shouldShowHeaderTitle;

  const accountMenuId = useId();
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const accountMenuInitialFocusIndexRef = useRef(0);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);

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
      } ${dashboard.isDarkMode ? "theme-dark" : "theme-light"}`}
    >
      <a className="dashboard-skip-link" href="#dashboard-main-content">
        본문으로 바로가기
      </a>
      <div className="dashboard-shell flex min-h-[100dvh] w-full flex-col bg-transparent md:flex-row">
        <Sidebar open animate={false}>
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
                  className="dashboard-account-menu dashboard-account-menu-open absolute left-0 right-auto top-full z-40 mt-1.5 origin-top rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg"
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
                    className="dashboard-account-menu-item flex w-full items-center rounded-lg text-left font-medium text-slate-700 outline-none transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-[var(--dashboard-accent)]/60 focus-visible:ring-inset"
                    onClick={() => {
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
                selection={dashboard.sidebarSelection}
                isDarkMode={dashboard.isDarkMode}
                onSelectProject={dashboard.goToProject}
                onSelectRecentPage={dashboard.goToRecentPage}
                onCreateProject={dashboard.openOrganizationCreateModal}
                onUpdateProject={dashboard.handleUpdateOrganizationModel}
                onDeleteProject={dashboard.handleDeleteOrganizationModel}
              />
            </div>
          </SidebarBody>
        </Sidebar>

        <main
          id="dashboard-main-content"
          tabIndex={-1}
          className={`min-w-0 flex-1 overflow-visible ${
            dashboard.menu === "analyze" ? "dashboard-analyze-view" : ""
          }`}
        >
          <div className="dashboard-top-zone relative px-4 sm:px-7 lg:px-10">
            <header className="dashboard-fixed-header absolute top-4 right-4 left-4 z-30 flex items-start justify-end gap-5 sm:top-7 sm:right-7 sm:left-7 lg:top-10 lg:right-10 lg:left-10">
              {shouldShowHeaderTitle && (
                <div
                  className={`pointer-events-auto absolute flex min-w-0 items-start justify-between gap-6 ${
                    isProjectDetailView
                      ? "dashboard-project-header-content top-[calc(var(--dashboard-control-size)-2.25rem)]"
                      : "dashboard-site-header-content left-0 right-0 top-[calc(var(--dashboard-control-size)+4.25rem)]"
                  }`}
                >
                  <div className="min-w-0">
                    {isProjectDetailView && (
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
                    )}
                    <div className="flex min-w-0 flex-wrap items-end gap-x-5 gap-y-2">
                      <h1
                        id={isSiteDetailView ? "dashboard-site-page-title" : undefined}
                        className={`dashboard-home-title shrink-0 font-black tracking-tight text-slate-900 ${
                          isProjectDetailView
                            ? "dashboard-project-title"
                            : isSiteDetailView
                              ? "dashboard-site-title"
                              : ""
                        }`}
                      >
                        {dashboard.headerTitle}
                      </h1>
                      {/* Site detail only: page URL. Project org description is not rendered. */}
                      {dashboard.headerDescriptionHref.length > 0 && (
                        <a
                          href={dashboard.headerDescriptionHref}
                          target="_blank"
                          rel="noreferrer"
                          className="dashboard-site-header-url -mb-1 inline-flex max-w-[42rem] truncate text-[0.95rem] font-medium text-[#8b95a1] underline underline-offset-4 transition-colors hover:text-slate-700"
                          title={dashboard.headerDescription}
                        >
                          {dashboard.headerDescription}
                        </a>
                      )}
                    </div>
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
            <Suspense fallback={<RoutePanelFallback />}>
              {dashboard.menu === "analyze" && (
                <QuickAnalyzePanel
                  isDarkMode={dashboard.isDarkMode}
                  onAnalysisComplete={dashboard.handleQuickAnalyzeComplete}
                />
              )}

              {dashboard.menu === "dashboard" && (
                <DashboardPanel
                  data={dashboard.dashboardData}
                  isLoading={dashboard.isDashboardLoading}
                  errorMessage={dashboard.dashboardError}
                  isDarkMode={dashboard.isDarkMode}
                  onSiteClick={({ siteId }) => dashboard.goToRecentPage(siteId)}
                  onRetry={dashboard.refreshDashboard}
                  onCreateProject={dashboard.openOrganizationCreateModal}
                  onStartEvaluation={dashboard.goToProjectsRoot}
                />
              )}

              {dashboard.menu === "projects" && dashboard.selectedOrganizationModel && dashboard.selectedEvaluationTargetModel && (
                <SiteDashboardPanel
                  evaluationTarget={dashboard.selectedEvaluationTargetModel}
                  evaluationRequests={dashboard.dashboardData?.evaluationRequests ?? []}
                  resultSummaries={dashboard.dashboardData?.resultSummaries ?? []}
                  analysisResults={dashboard.dashboardData?.analysisResults ?? []}
                  scoreResults={dashboard.dashboardData?.scoreResults ?? []}
                  issueResults={dashboard.dashboardData?.issueResults ?? []}
                  improvementGuides={dashboard.dashboardData?.improvementGuides ?? []}
                />
              )}

              {dashboard.menu === "projects" &&
                dashboard.selectedOrganizationModel &&
                !dashboard.selectedEvaluationTargetModel && (
                  <OrganizationModelDetailPanel
                    organization={dashboard.selectedOrganizationModel}
                    evaluationRequests={dashboard.dashboardData?.evaluationRequests ?? []}
                    analysisResults={dashboard.dashboardData?.analysisResults ?? []}
                    scoreResults={dashboard.dashboardData?.scoreResults ?? []}
                    issueResults={dashboard.dashboardData?.issueResults ?? []}
                    isDarkMode={dashboard.isDarkMode}
                    onDeleteEvaluationTargetModel={dashboard.handleDeleteEvaluationTargetModel}
                    onOpenCreateSiteModal={dashboard.openSiteCreateModal}
                    onSiteClick={dashboard.goToSite}
                  />
                )}

            </Suspense>
          </div>

          {dashboard.selectedOrganizationModel && (
            <SiteCreateModal
              key={dashboard.selectedOrganizationModel.id}
              isOpen={dashboard.isSiteCreateOpen}
              isDarkMode={dashboard.isDarkMode}
              project={dashboard.selectedOrganizationModel}
              onCreateEvaluationTargetModel={dashboard.handleCreateEvaluationTargetModel}
              onRequestEvaluationTargetAnalysis={dashboard.handleRequestEvaluationTargetAnalysis}
              onAnalysisComplete={dashboard.refreshDashboardForSiteCreate}
              onClose={() => dashboard.setIsSiteCreateOpen(false)}
            />
          )}

          <OrganizationModelCreateModal
            isOpen={dashboard.isOrganizationCreateOpen}
            isDarkMode={dashboard.isDarkMode}
            name={dashboard.newOrganizationModelName}
            isSubmitting={dashboard.isCreatingOrganizationModel}
            hasCreatedOrganization={dashboard.hasCreatedOrganization}
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

          <AccountSettingsModal
            isOpen={isAccountSettingsOpen}
            isDarkMode={dashboard.isDarkMode}
            themeMode={dashboard.themeMode}
            onThemeModeChange={dashboard.setThemeMode}
            onClose={closeAccountSettings}
          />

        </main>
      </div>
    </div>
  );
}
