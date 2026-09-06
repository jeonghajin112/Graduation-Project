import { Link2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { SidebarItem } from "@/components/ui/sidebar";
import {
  deleteEvaluationTargetModel,
  deleteOrganizationModel,
  updateOrganizationModel
} from "@/services/backend-api";
import { parseDashboardRoute } from "@/services/dashboard-route";
import type { EvaluationRequestModel } from "@/types/accessibility-domain";

import { useDashboardData } from "./use-dashboard-data";
import { useDashboardTheme } from "./use-dashboard-theme";
import { useOrganizationModelCreateForm } from "./use-organization-model-create-form";
import { useSiteCreateWorkflow } from "./use-site-create-workflow";
import { formatDateTime } from "./utils";

const APP_HOME_PATH = "/analyze";


export function useDashboardController({
  onBootstrapComplete
}: {
  onBootstrapComplete?: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isDarkMode, themeMode, setThemeMode } = useDashboardTheme();
  const routeState = useMemo(() => parseDashboardRoute(location.pathname), [location.pathname]);
  const {
    beginDirectoryRecovery,
    trackEvaluationRequest,
    dashboardData,
    dashboardError,
    endDirectoryRecovery,
    isDashboardLoading,
    loadDashboard
  } = useDashboardData({ onBootstrapComplete });

  const [isSiteCreateOpen, setIsSiteCreateOpen] = useState(false);
  const organizationCreationNavigationRef = useRef<number | null>(null);
  const {
    handleCreateEvaluationTargetModel,
    handleRequestEvaluationTargetAnalysis
  } = useSiteCreateWorkflow({
    beginDirectoryRecovery,
    dashboardData,
    endDirectoryRecovery,
    loadDashboard
  });

  const handleOrganizationModelCreated = useCallback(
    (projectId: number) => {
      // Claim the intended destination synchronously. Effects from the render
      // that removed the previous project must not overwrite this navigation.
      organizationCreationNavigationRef.current = projectId;
      navigate(`/projects/${projectId}`);
    },
    [navigate]
  );
  const organizationCreateForm = useOrganizationModelCreateForm({
    beginDirectoryRecovery,
    dashboardData,
    endDirectoryRecovery,
    loadDashboard,
    onCreated: handleOrganizationModelCreated
  });

  const selectedOrganizationModel = useMemo(() => {
    if (routeState.selectedOrganizationModelId !== null) {
      return (
        dashboardData?.organizations.find(
          (organization) => organization.id === routeState.selectedOrganizationModelId
        ) ?? null
      );
    }

    if (routeState.kind !== "recentPage" || routeState.selectedEvaluationTargetModelId === null) {
      return null;
    }

    return (
      dashboardData?.organizations.find((organization) =>
        organization.evaluationTargets.some(
          (target) => target.id === routeState.selectedEvaluationTargetModelId
        )
      ) ?? null
    );
  }, [
    dashboardData?.organizations,
    routeState.kind,
    routeState.selectedEvaluationTargetModelId,
    routeState.selectedOrganizationModelId
  ]);

  const selectedEvaluationTargetModel = useMemo(() => {
    if (!selectedOrganizationModel || routeState.selectedEvaluationTargetModelId === null) {
      return null;
    }

    return (
      selectedOrganizationModel.evaluationTargets.find(
        (target) => target.id === routeState.selectedEvaluationTargetModelId
      ) ?? null
    );
  }, [routeState.selectedEvaluationTargetModelId, selectedOrganizationModel]);

  const isProjectDetailView =
    routeState.menu === "projects" &&
    selectedOrganizationModel !== null &&
    selectedEvaluationTargetModel === null;

  useEffect(() => {
    if (!selectedOrganizationModel?.systemManaged) return;
    if (routeState.kind === "projectPage" && selectedEvaluationTargetModel) {
      navigate(`/recent-pages/${selectedEvaluationTargetModel.id}`, { replace: true });
    } else if (routeState.kind === "project") {
      navigate(APP_HOME_PATH, { replace: true });
    }
  }, [navigate, routeState.kind, selectedOrganizationModel, selectedEvaluationTargetModel]);
  const isSiteDetailView =
    routeState.menu === "projects" &&
    selectedOrganizationModel !== null &&
    selectedEvaluationTargetModel !== null;

  useEffect(() => {
    setIsSiteCreateOpen(false);
  }, [selectedOrganizationModel?.id]);

  // Project list page removed — bare /projects goes to app home (quick analyze).
  useEffect(() => {
    if (routeState.kind === "invalidProject") {
      navigate(APP_HOME_PATH, { replace: true });
    }
  }, [navigate, routeState.kind]);

  useEffect(() => {
    const creationTargetId = organizationCreationNavigationRef.current;
    if (
      creationTargetId !== null &&
      routeState.selectedOrganizationModelId === creationTargetId &&
      dashboardData?.organizations.some((project) => project.id === creationTargetId)
    ) {
      organizationCreationNavigationRef.current = null;
    }
  }, [dashboardData, routeState.selectedOrganizationModelId]);

  useEffect(() => {
    if (
      organizationCreationNavigationRef.current !== null ||
      !dashboardData ||
      routeState.selectedOrganizationModelId === null
    ) {
      return;
    }

    const projectStillExists = dashboardData.organizations.some(
      (project) => project.id === routeState.selectedOrganizationModelId
    );
    if (!projectStillExists) {
      navigate(APP_HOME_PATH, { replace: true });
    }
  }, [dashboardData, navigate, routeState.selectedOrganizationModelId]);

  useEffect(() => {
    if (
      organizationCreationNavigationRef.current !== null ||
      !dashboardData ||
      routeState.selectedEvaluationTargetModelId === null
    ) {
      return;
    }

    if (routeState.kind === "recentPage" && !selectedEvaluationTargetModel) {
      navigate(APP_HOME_PATH, { replace: true });
      return;
    }

    if (
      routeState.kind === "projectPage" &&
      selectedOrganizationModel &&
      !selectedEvaluationTargetModel
    ) {
      navigate(`/projects/${routeState.selectedOrganizationModelId}`, { replace: true });
    }
  }, [
    dashboardData,
    navigate,
    routeState.kind,
    routeState.selectedEvaluationTargetModelId,
    routeState.selectedOrganizationModelId,
    selectedEvaluationTargetModel,
    selectedOrganizationModel
  ]);

  const handleUpdateOrganizationModel = useCallback(
    async ({
      projectId,
      name,
      description
    }: {
      projectId: number;
      name: string;
      description: string;
    }) => {
      await updateOrganizationModel({
        projectId,
        name,
        description
      });

      await loadDashboard({ refreshAfterInFlight: true, clearOnError: false });
    },
    [loadDashboard]
  );

  const handleDeleteOrganizationModel = useCallback(
    async (projectId: number) => {
      await deleteOrganizationModel(projectId);

      if (routeState.selectedOrganizationModelId === projectId) {
        navigate(APP_HOME_PATH, { replace: true });
      }

      await loadDashboard({ refreshAfterInFlight: true, clearOnError: false });
    },
    [loadDashboard, navigate, routeState.selectedOrganizationModelId]
  );

  const handleDeleteEvaluationTargetModel = useCallback(
    async ({ projectId, siteId }: { projectId: number; siteId: number }) => {
      await deleteEvaluationTargetModel({
        projectId,
        siteId
      });

      await loadDashboard({ refreshAfterInFlight: true, clearOnError: false });
    },
    [loadDashboard]
  );
  const sidebarLinks: SidebarItem[] = useMemo(
    () => [
      {
        label: "새 페이지 분석",
        href: APP_HOME_PATH,
        icon: <Link2 size={18} />,
        onClick: () => navigate(APP_HOME_PATH),
        active: routeState.menu === "analyze"
      }
    ],
    [navigate, routeState.menu]
  );

  const headerTitle =
    routeState.menu === "analyze"
      ? "새 페이지 분석"
      : isSiteDetailView
        ? selectedEvaluationTargetModel!.name
        : isProjectDetailView
          ? selectedOrganizationModel!.name
          : "프로젝트";
  const siteLatestScanLabel = useMemo(() => {
    if (!isSiteDetailView || !selectedEvaluationTargetModel) {
      return "";
    }

    const latestUpdatedAt = (dashboardData?.evaluationRequests ?? [])
      .filter((request) => request.evaluationTargetId === selectedEvaluationTargetModel.id)
      .map((request) => request.updatedAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

    return latestUpdatedAt ? formatDateTime(latestUpdatedAt) : "스캔 기록 없음";
  }, [dashboardData?.evaluationRequests, isSiteDetailView, selectedEvaluationTargetModel]);

  const goToProject = useCallback(
    (projectId: number) => {
      navigate(`/projects/${projectId}`);
    },
    [navigate]
  );
  const goToProjectsRoot = useCallback(() => {
    navigate(APP_HOME_PATH);
  }, [navigate]);
  const goToSite = useCallback(
    (siteId: number) => {
      if (!selectedOrganizationModel) {
        return;
      }
      navigate(`/projects/${selectedOrganizationModel.id}/pages/${siteId}`);
    },
    [navigate, selectedOrganizationModel]
  );
  const goToRecentPage = useCallback(
    (pageId: number) => {
      navigate(`/recent-pages/${pageId}`);
    },
    [navigate]
  );
  const goBackToProject = useCallback(() => {
    if (!selectedOrganizationModel) {
      return;
    }
    navigate(`/projects/${selectedOrganizationModel.id}`);
  }, [navigate, selectedOrganizationModel]);
  const refreshDashboard = useCallback(
    () =>
      loadDashboard({
        refreshAfterInFlight: true,
        showLoading: true,
        clearOnError: false
      }),
    [loadDashboard]
  );
  const handleAnalysisAccepted = useCallback(
    (request: EvaluationRequestModel) => {
      trackEvaluationRequest(request);
      void loadDashboard({ refreshAfterInFlight: true, clearOnError: false });
    },
    [loadDashboard, trackEvaluationRequest]
  );
  const handleQuickAnalysisAccepted = useCallback(
    (request: EvaluationRequestModel) => {
      handleAnalysisAccepted({ ...request, quickAnalysis: true });
    },
    [handleAnalysisAccepted]
  );
  const organizations = dashboardData?.organizations ?? [];
  const selectedOrganizationModelId = selectedOrganizationModel?.id ?? null;

  return {
    canDiscardOrganizationCreateRecovery:
      organizationCreateForm.canDiscardOrganizationCreateRecovery,
    dashboardData,
    dashboardError,
    goBackToProject,
    goToProject,
    goToProjectsRoot,
    goToRecentPage,
    goToSite,
    handleAnalysisAccepted,
    handleQuickAnalysisAccepted,
    handleCreateEvaluationTargetModel,
    handleRequestEvaluationTargetAnalysis,
    handleDeleteEvaluationTargetModel,
    handleCreateOrganizationModel: organizationCreateForm.handleCreateOrganizationModel,
    discardOrganizationCreateRecovery:
      organizationCreateForm.discardOrganizationCreateRecovery,
    handleDeleteOrganizationModel,
    handleUpdateOrganizationModel,
    headerTitle,
    hasPendingOrganizationCreate: organizationCreateForm.hasPendingOrganizationCreate,
    isCreatingOrganizationModel: organizationCreateForm.isCreatingOrganizationModel,
    isOrganizationCreateRecoveryBlocked:
      organizationCreateForm.isOrganizationCreateRecoveryBlocked,
    isDarkMode,
    isDashboardLoading,
    isOrganizationCreateOpen: organizationCreateForm.isOrganizationCreateOpen,
    isSiteCreateOpen,
    menu: routeState.menu,
    newOrganizationModelName: organizationCreateForm.newOrganizationModelName,
    openOrganizationCreateModal: organizationCreateForm.openOrganizationCreateModal,
    openSiteCreateModal: () => {
      setIsSiteCreateOpen(true);
    },
    organizations,
    projectCreateError: organizationCreateForm.projectCreateError,
    refreshDashboard,
    selectedEvaluationTargetModel,
    selectedOrganizationModel,
    selectedOrganizationModelId,
    sidebarSelection: routeState.sidebarSelection,
    siteLatestScanLabel,
    setIsOrganizationCreateOpen: organizationCreateForm.setIsOrganizationCreateOpen,
    setIsSiteCreateOpen,
    setNewOrganizationModelName: organizationCreateForm.setNewOrganizationModelName,
    setThemeMode,
    sidebarLinks,
    themeMode
  };
}
