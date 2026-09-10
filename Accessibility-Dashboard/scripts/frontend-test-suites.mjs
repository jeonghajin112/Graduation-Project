const nodeTest = (file, options = {}) => ({
  file,
  needsVite: false,
  ...options
});

const viteTest = (file, options = {}) => ({
  file,
  needsVite: true,
  ...options
});

const infrastructure = nodeTest("verify-test-infrastructure.mjs");
const accessibility = viteTest("verify-accessibility-p0.mjs");
const dashboardBootAccessibility = viteTest("verify-dashboard-boot-accessibility.mjs");
const pollingCancel = viteTest("verify-analysis-polling-cancel.mjs");
const quickAnalysisProgress = viteTest("verify-quick-analysis-progress.mjs");
const quickAnalysisPlacement = viteTest("verify-quick-analysis-placement.mjs");
const siteAnalysisProgress = viteTest("verify-site-analysis-progress.mjs");
const dashboardStatusPolling = viteTest("verify-dashboard-status-polling.mjs");
const apiResponseValidation = viteTest("verify-api-response-validation.mjs");
const dashboardRequestBudget = viteTest("verify-dashboard-request-budget.mjs");
const directoryRecoveryLeases = viteTest("verify-directory-recovery-leases.mjs");
const analysisRequestLeaseRelease = viteTest("verify-analysis-request-lease-release.mjs");
const mutationRefresh = viteTest("verify-dashboard-mutation-refresh.mjs");
const mutationSubmitGuards = viteTest("verify-mutation-submit-guards.mjs");
const directoryMutationRecovery = viteTest("verify-directory-mutation-recovery.mjs");
const rescanRecoveryIsolation = viteTest("verify-rescan-recovery-isolation.mjs");
const organizationPostTimeout = viteTest("verify-organization-create-post-timeout.mjs");
const organizationRefreshRetry = viteTest("verify-organization-create-refresh-retry.mjs");
const organizationReloadRecovery = viteTest("verify-organization-create-reload-recovery.mjs");
const quickRecovery = viteTest("verify-quick-rescan-recovery-guards.mjs", {
  label: "verify-quick-rescan-recovery-guards.mjs (Quick Analyze only)"
});
const routeResilienceAccessibility = viteTest("verify-route-resilience-accessibility.mjs");
const sidebarSelection = nodeTest("verify-sidebar-selection.mjs");
const sidebarRouteSelection = viteTest("verify-sidebar-route-selection.mjs");
const siteCreateRequestRetry = viteTest("verify-site-create-request-retry.mjs");
const siteCreateAccessibilityGuards = viteTest("verify-site-create-accessibility-guards.mjs");
const pageEvidenceCore = viteTest("verify-page-evidence.mjs", {
  environment: { PAGE_EVIDENCE_SCOPE: "core" },
  label: "verify-page-evidence.mjs (core)"
});
const pageEvidenceFull = viteTest("verify-page-evidence.mjs", {
  environment: { PAGE_EVIDENCE_SCOPE: "full" },
  label: "verify-page-evidence.mjs (full)"
});
const pageEvidenceScale = viteTest("verify-page-evidence.mjs", {
  environment: { PAGE_EVIDENCE_SCOPE: "scale" },
  label: "verify-page-evidence.mjs (scale)"
});
const siteDashboardRail = viteTest("verify-site-dashboard-rail.mjs");
const landingDesign = viteTest("verify-landing-design.mjs");
const modalAppearance = viteTest("verify-modal-appearance.mjs");
const dashboardResponsiveLayout = viteTest("verify-dashboard-responsive-layout.mjs");

const ci = [
  infrastructure,
  accessibility,
  modalAppearance,
  dashboardResponsiveLayout,
  landingDesign,
  dashboardBootAccessibility,
  pollingCancel,
  quickAnalysisProgress,
  quickAnalysisPlacement,
  siteAnalysisProgress,
  dashboardStatusPolling,
  apiResponseValidation,
  dashboardRequestBudget,
  directoryRecoveryLeases,
  analysisRequestLeaseRelease,
  mutationRefresh,
  mutationSubmitGuards,
  directoryMutationRecovery,
  rescanRecoveryIsolation,
  quickRecovery,
  organizationPostTimeout,
  organizationRefreshRetry,
  organizationReloadRecovery,
  routeResilienceAccessibility,
  sidebarSelection,
  sidebarRouteSelection,
  siteCreateRequestRetry,
  siteCreateAccessibilityGuards,
  pageEvidenceCore,
  siteDashboardRail
];

const browser = [
  ...ci.filter(
    (test) =>
      test.needsVite &&
      test.file !== pageEvidenceCore.file &&
      test.file !== landingDesign.file
  ),
  pageEvidenceFull,
  landingDesign
];

export const FRONTEND_TEST_SUITES = Object.freeze({
  ci,
  browser,
  recovery: [quickRecovery],
  visual: [landingDesign],
  scale: [pageEvidenceScale],
  replay: [
    nodeTest("verify-live-report-markers.mjs", { crossStack: true }),
    nodeTest("verify-live-report-boundaries.mjs", { crossStack: true })
  ],
  backend: [
    viteTest("verify-sidebar-browser.mjs", { needsBackend: true }),
    viteTest("verify-sidebar-disclosure.mjs", { needsBackend: true })
  ]
});
