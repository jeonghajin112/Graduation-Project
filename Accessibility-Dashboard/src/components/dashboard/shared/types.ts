import type { EvaluationTargetModel, MenuType, OrganizationModel } from "@/types/accessibility-domain";

export interface SidebarDemoProps {
  onLogout?: () => void;
  userName: string;
  onBootstrapComplete?: () => void;
}

export interface DashboardRouteState {
  menu: MenuType;
  selectedOrganizationModelId: number | null;
  selectedEvaluationTargetModelId: number | null;
}

export interface DashboardSelectionState {
  selectedOrganizationModel: OrganizationModel | null;
  selectedEvaluationTargetModel: EvaluationTargetModel | null;
}
