import { Suspense, lazy } from "react";

import { ErrorBoundary } from "@/components/shared/error-boundary";

import { RoutePanelErrorFallback, RoutePanelFallback } from "./shared/route-panel-fallbacks";
import type { DashboardActions, DashboardView } from "./dashboard-surface.types";
import type { SiteDashboardPreviewEvidence } from "./panels/site-dashboard-panel";

const QuickAnalyzePanel = lazy(() =>
  import("./panels/quick-analyze-panel").then((module) => ({ default: module.QuickAnalyzePanel }))
);
const OrganizationModelDetailPanel = lazy(() =>
  import("./panels/project-detail-panel").then((module) => ({ default: module.OrganizationModelDetailPanel }))
);
const SiteDashboardPanel = lazy(() =>
  import("./panels/site-dashboard-panel").then((module) => ({ default: module.SiteDashboardPanel }))
);

/** The panel of the current route: quick analysis, a project, or one of its pages. */
export function DashboardRoutePanels({
  dashboard,
  actions,
  routeKey,
  previewEvidenceByTargetId
}: {
  dashboard: DashboardView;
  /** Null in the read-only preview. */
  actions: DashboardActions | null;
  routeKey: string;
  previewEvidenceByTargetId?: ReadonlyMap<number, SiteDashboardPreviewEvidence>;
}) {
  const project = dashboard.menu === "projects" ? dashboard.selectedOrganizationModel : null;
  const page = project ? dashboard.selectedEvaluationTargetModel : null;
  const evaluationRequests = dashboard.dashboardData?.evaluationRequests ?? [];
  const scoreResults = dashboard.dashboardData?.scoreResults ?? [];

  return (
    <ErrorBoundary resetKey={routeKey} fallback={RoutePanelErrorFallback}>
      <Suspense fallback={<RoutePanelFallback />}>
        {dashboard.menu === "analyze" && (
          <QuickAnalyzePanel
            supportsIdempotency={dashboard.dashboardData?.analysisProtocolVersion === 1}
            {...(actions
              ? { onAnalysisAccepted: actions.handleQuickAnalysisAccepted }
              : { readOnly: true })}
          />
        )}

        {page && (
          <SiteDashboardPanel
            onRequestEvaluationTargetAnalysis={actions?.handleRequestEvaluationTargetAnalysis}
            onAnalysisAccepted={actions?.handleAnalysisAccepted}
            evaluationTarget={page}
            evaluationRequests={evaluationRequests}
            resultSummaries={dashboard.dashboardData?.resultSummaries ?? []}
            scoreResults={scoreResults}
            previewEvidence={previewEvidenceByTargetId?.get(page.id)}
          />
        )}

        {project && !page && (
          <OrganizationModelDetailPanel
            organization={project}
            evaluationRequests={evaluationRequests}
            scoreResults={scoreResults}
            actions={actions ? {
              onDeleteEvaluationTargetModel: actions.handleDeleteEvaluationTargetModel,
              onOpenCreateSiteModal: actions.openSiteCreateModal
            } : null}
            onSiteClick={dashboard.goToSite}
          />
        )}
      </Suspense>
    </ErrorBoundary>
  );
}
