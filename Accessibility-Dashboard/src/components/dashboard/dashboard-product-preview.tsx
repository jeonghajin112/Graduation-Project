import { useMemo, useState } from "react";
import { Link2 } from "lucide-react";

import type { DashboardSidebarSelection } from "@/services/dashboard-route";

import {
  PRODUCT_DEMO_DASHBOARD,
  PRODUCT_DEMO_EVIDENCE,
  PRODUCT_DEMO_ORGANIZATIONS,
  PRODUCT_DEMO_QUICK_ANALYSIS_RESULTS
} from "./preview/product-demo-data";
import { useDashboardTheme } from "./shared/use-dashboard-theme";
import { DashboardSurface } from "./dashboard-surface";
import type { DashboardView } from "./dashboard-surface.types";

type PreviewSelection = {
  pageId: number | null;
  projectId: number;
};

const INITIAL_SELECTION: PreviewSelection = {
  pageId: null,
  projectId: PRODUCT_DEMO_ORGANIZATIONS[0]!.id
};

export function DashboardProductPreview() {
  const [selection, setSelection] = useState<PreviewSelection>(INITIAL_SELECTION);
  const [menu, setMenu] = useState<"analyze" | "projects">("projects");
  const [isRecentSelection, setIsRecentSelection] = useState(false);
  const { isDarkMode, setThemeMode, themeMode } = useDashboardTheme({
    initialMode: "light",
    persist: false
  });

  const selectedOrganizationModel = useMemo(
    () =>
      PRODUCT_DEMO_ORGANIZATIONS.find(
        (organization) => organization.id === selection.projectId
      ) ?? PRODUCT_DEMO_ORGANIZATIONS[0]!,
    [selection.projectId]
  );
  const selectedEvaluationTargetModel = useMemo(
    () =>
      selection.pageId === null
        ? null
        : selectedOrganizationModel.evaluationTargets.find(
            (target) => target.id === selection.pageId
          ) ?? null,
    [selectedOrganizationModel, selection.pageId]
  );
  let sidebarSelection: DashboardSidebarSelection | null = null;
  if (menu === "projects") {
    sidebarSelection = selection.pageId === null
      ? { kind: "project", id: selectedOrganizationModel.id }
      : isRecentSelection
        ? { kind: "recentPage", id: selection.pageId }
        : {
            kind: "projectPage",
            pageId: selection.pageId,
            projectId: selectedOrganizationModel.id
          };
  }

  const goToProject = (projectId: number) => {
    setIsRecentSelection(false);
    setSelection({ pageId: null, projectId });
  };
  const goToSite = (pageId: number) => {
    const owner = PRODUCT_DEMO_ORGANIZATIONS.find((organization) =>
      organization.evaluationTargets.some((target) => target.id === pageId)
    );
    if (owner) {
      setIsRecentSelection(false);
      setSelection({ pageId, projectId: owner.id });
    }
  };

  const dashboard = {
    dashboardData: PRODUCT_DEMO_DASHBOARD,
    dashboardError: "",
    goToProject: (projectId: number) => {
      setMenu("projects");
      goToProject(projectId);
    },
    goToRecentPage: (pageId: number) => {
      setMenu("projects");
      const owner = PRODUCT_DEMO_ORGANIZATIONS.find((organization) =>
        organization.evaluationTargets.some((target) => target.id === pageId)
      );
      if (owner) {
        setIsRecentSelection(true);
        setSelection({ pageId, projectId: owner.id });
      }
    },
    goToSite: (pageId: number) => {
      setMenu("projects");
      goToSite(pageId);
    },
    headerTitle:
      menu === "analyze"
        ? "새 페이지 분석"
        : selectedEvaluationTargetModel?.name ?? selectedOrganizationModel.name,
    isDarkMode,
    isDashboardLoading: false,
    menu,
    organizations: PRODUCT_DEMO_ORGANIZATIONS,
    selectedEvaluationTargetModel,
    selectedOrganizationModel,
    sidebarSelection,
    setThemeMode,
    sidebarLinks: [
      {
        label: "새 페이지 분석",
        href: "/analyze",
        icon: <Link2 size={18} />,
        onClick: () => {
          setMenu("analyze");
          setIsRecentSelection(false);
        },
        active: menu === "analyze"
      }
    ],
    themeMode
  } satisfies DashboardView;

  return (
    <DashboardSurface
      dashboard={dashboard}
      mode="preview"
      previewEvidenceByTargetId={PRODUCT_DEMO_EVIDENCE}
      previewQuickAnalysisResults={PRODUCT_DEMO_QUICK_ANALYSIS_RESULTS}
      userName="ADMIN"
    />
  );
}
