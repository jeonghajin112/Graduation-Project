import { Suspense, lazy } from "react";
import { ErrorBoundary, isLazyChunkLoadError } from "@/components/shared/error-boundary";
import { ModalErrorFallback, ModalLoadFallback } from "./shared/modal-load-fallback";
import type { useDashboardController } from "./shared/use-dashboard-controller";

const OrganizationModelCreateModal = lazy(() =>
  import("./modals/organization-model-create-modal").then((module) => ({
    default: module.OrganizationModelCreateModal
  }))
);
const SiteCreateModal = lazy(() =>
  import("./modals/site-create-modal").then((module) => ({ default: module.SiteCreateModal }))
);

// Only the live container supplies creation and recovery state.
export function DashboardMutationModals({ dashboard }: {
  dashboard: ReturnType<typeof useDashboardController>;
}) {
  return (
    <>
      {dashboard.selectedOrganizationModel && dashboard.isSiteCreateOpen && (
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

      {dashboard.isOrganizationCreateOpen && (
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

    </>
  );
}
