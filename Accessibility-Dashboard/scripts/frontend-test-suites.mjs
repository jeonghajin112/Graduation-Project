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
const dashboardStatusPolling = viteTest("verify-dashboard-status-polling.mjs");
const artifactLateArrival = viteTest("verify-artifact-late-arrival.mjs");
const apiResponseValidation = viteTest("verify-api-response-validation.mjs");
const dashboardRequestBudget = viteTest("verify-dashboard-request-budget.mjs");
const directoryRecoveryLeases = viteTest("verify-directory-recovery-leases.mjs");
const analysisRequestLeaseRelease = viteTest("verify-analysis-request-lease-release.mjs");
const mutationRefresh = viteTest("verify-dashboard-mutation-refresh.mjs");
const mutationSubmitGuards = viteTest("verify-mutation-submit-guards.mjs");
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

const ci = [
  infrastructure,
  accessibility,
  landingDesign,
  dashboardBootAccessibility,
  pollingCancel,
  dashboardStatusPolling,
  artifactLateArrival,
  apiResponseValidation,
  dashboardRequestBudget,
  directoryRecoveryLeases,
  analysisRequestLeaseRelease,
  mutationRefresh,
  mutationSubmitGuards,
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
    nodeTest("verify-replay-interactions.mjs", { crossStack: true }),
    nodeTest("verify-replay-interactive-obstacles.mjs", { crossStack: true }),
    nodeTest("verify-replay-marker-collision.mjs", { crossStack: true }),
    nodeTest("verify-replay-marker-hover.mjs", { crossStack: true }),
    nodeTest("verify-replay-marker-performance.mjs", { crossStack: true }),
    nodeTest("verify-replay-marker-popover.mjs", { crossStack: true }),
    nodeTest("verify-replay-sector-grouping.mjs", { crossStack: true })
  ],
  backend: [
    viteTest("verify-sidebar-browser.mjs", { needsBackend: true }),
    viteTest("verify-sidebar-disclosure.mjs", { needsBackend: true })
  ]
});

export const FRONTEND_TEST_MIGRATIONS = Object.freeze([
  {
    file: "verify-organization-create-frontend-guards.mjs",
    status: "retired",
    replacements: [
      "verify-directory-recovery-leases.mjs",
      "verify-organization-create-post-timeout.mjs",
      "verify-organization-create-refresh-retry.mjs",
      "verify-organization-create-reload-recovery.mjs",
      "verify-dashboard-mutation-refresh.mjs"
    ],
    reason: "The aggregate-overview tests now include the nested directory recovery lease regression."
  },
  {
    file: "verify-partial-result-isolation.mjs",
    status: "retired",
    replacements: [
      "verify-dashboard-request-budget.mjs",
      "verify-api-response-validation.mjs",
      "verify-artifact-late-arrival.mjs"
    ],
    reason: "The removed per-request directory/result cache made the legacy endpoint and clock-expiry contract obsolete."
  },
  {
    file: "verify-rescan-result-retention.mjs",
    status: "retired",
    replacements: ["verify-dashboard-request-budget.mjs"],
    reason: "The rescan action was removed; latest-completed-result selection is covered at the aggregate overview boundary."
  },
  {
    file: "verify-site-create-guards.mjs",
    status: "retired",
    replacements: [
      "verify-site-create-accessibility-guards.mjs",
      "verify-site-create-request-retry.mjs",
      "verify-mutation-submit-guards.mjs",
      "verify-dashboard-mutation-refresh.mjs"
    ],
    reason: "Current aggregate fixtures cover request recovery, mobile overflow, and storage-failure guards."
  },
  {
    file: "verify-site-detail-design.mjs",
    status: "retired",
    replacements: ["verify-page-evidence.mjs"],
    reason: "Its replay-only layout assertions contradict the current page-detail cards and header."
  }
]);
