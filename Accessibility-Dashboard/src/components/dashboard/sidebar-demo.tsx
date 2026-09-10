import { DashboardMutationModals } from "./dashboard-mutation-modals";
import { DashboardSurface } from "./dashboard-surface";
import type { DashboardActions, DashboardView } from "./dashboard-surface.types";
import type { SidebarDemoProps } from "./shared/types";
import { useDashboardController } from "./shared/use-dashboard-controller";

export function SidebarDemo({ onLogout, userName, onBootstrapComplete }: SidebarDemoProps) {
  const dashboard = useDashboardController({ onBootstrapComplete });
  const view = dashboard satisfies DashboardView;
  const actions = dashboard satisfies DashboardActions;

  return (
    <DashboardSurface
      dashboard={view}
      mode="live"
      actions={actions}
      mutationModals={<DashboardMutationModals dashboard={dashboard} />}
      onLogout={onLogout}
      userName={userName}
    />
  );
}
