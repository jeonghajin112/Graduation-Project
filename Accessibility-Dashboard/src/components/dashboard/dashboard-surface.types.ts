import type { ReactNode } from "react";

import type { SidebarItem } from "@/components/ui/sidebar";
import type { DashboardSidebarSelection } from "@/services/dashboard-route";
import type { QuickAnalysisResultRecord } from "@/services/quick-analysis-registry";
import type {
  DashboardViewModel,
  EvaluationRequestModel,
  EvaluationTargetModel,
  MenuType,
  OrganizationModel
} from "@/types/accessibility-domain";
import type { ThemeMode } from "@/types/theme";

import type { SiteDashboardPreviewEvidence } from "./panels/site-dashboard-panel";

// Rendering and navigation do not require creation forms or recovery state.
export type DashboardView = {
  dashboardData: DashboardViewModel | null;
  dashboardError: string;
  headerTitle: string;
  isDashboardLoading: boolean;
  isDarkMode: boolean;
  menu: MenuType;
  organizations: OrganizationModel[];
  selectedOrganizationModel: OrganizationModel | null;
  selectedEvaluationTargetModel: EvaluationTargetModel | null;
  sidebarLinks: SidebarItem[];
  sidebarSelection: DashboardSidebarSelection | null;
  themeMode: ThemeMode;
  goToProject: (projectId: number) => void;
  goToRecentPage: (pageId: number) => void;
  goToSite: (pageId: number) => void;
  setThemeMode: (mode: ThemeMode) => void;
};

export type SidebarProjectActions = {
  onCreateProject: () => void;
  onUpdateProject: (input: { projectId: number; name: string; description: string }) => Promise<void>;
  onDeleteProject: (projectId: number) => Promise<void>;
};

export type ProjectPageActions = {
  onOpenCreateSiteModal: () => void;
  onDeleteEvaluationTargetModel: (input: { projectId: number; siteId: number }) => Promise<void>;
};

export type DashboardActions = {
  openOrganizationCreateModal: SidebarProjectActions["onCreateProject"];
  handleUpdateOrganizationModel: SidebarProjectActions["onUpdateProject"];
  handleDeleteOrganizationModel: SidebarProjectActions["onDeleteProject"];
  openSiteCreateModal: ProjectPageActions["onOpenCreateSiteModal"];
  handleDeleteEvaluationTargetModel: ProjectPageActions["onDeleteEvaluationTargetModel"];
  handleQuickAnalysisAccepted: (request: EvaluationRequestModel) => void;
  handleAnalysisAccepted: (request: EvaluationRequestModel) => void;
  handleRequestEvaluationTargetAnalysis: (
    targetId: number, signal?: AbortSignal, previousFailedRequestId?: number
  ) => Promise<number>;
  refreshDashboard: () => Promise<DashboardViewModel | null>;
};

export type DashboardSurfaceProps = {
  dashboard: DashboardView;
  userName: string;
} & (
  | {
      mode: "live";
      actions: DashboardActions;
      mutationModals: ReactNode;
      onLogout?: () => void;
    }
  | {
      mode: "preview";
      actions?: never;
      mutationModals?: never;
      onLogout?: never;
      previewEvidenceByTargetId: ReadonlyMap<number, SiteDashboardPreviewEvidence>;
      previewQuickAnalysisResults: readonly QuickAnalysisResultRecord[];
    }
);
