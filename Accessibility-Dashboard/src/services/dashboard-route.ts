import type { MenuType } from "@/types/accessibility-domain";

export type DashboardSidebarSelection =
  | { kind: "project"; id: number }
  | { kind: "projectPage"; projectId: number; pageId: number }
  | { kind: "recentPage"; id: number };

export type DashboardRouteKind =
  | "dashboard"
  | "analyze"
  | "reports"
  | "project"
  | "projectPage"
  | "recentPage"
  | "invalidProject";

export type ParsedDashboardRoute = {
  kind: DashboardRouteKind;
  menu: MenuType;
  selectedOrganizationModelId: number | null;
  selectedEvaluationTargetModelId: number | null;
  sidebarSelection: DashboardSidebarSelection | null;
};

function parsePositiveInteger(segment: string | undefined): number | null {
  if (!segment || !/^[1-9]\d*$/.test(segment)) {
    return null;
  }

  const value = Number(segment);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseDashboardRoute(pathname: string): ParsedDashboardRoute {
  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] === "dashboard") {
    return {
      kind: "dashboard",
      menu: "dashboard",
      selectedOrganizationModelId: null,
      selectedEvaluationTargetModelId: null,
      sidebarSelection: null
    };
  }

  if (segments[0] === "reports") {
    return {
      kind: "reports",
      menu: "reports",
      selectedOrganizationModelId: null,
      selectedEvaluationTargetModelId: null,
      sidebarSelection: null
    };
  }

  if (segments[0] === "projects") {
    const projectId = parsePositiveInteger(segments[1]);
    if (projectId === null) {
      return {
        kind: "invalidProject",
        menu: "projects",
        selectedOrganizationModelId: null,
        selectedEvaluationTargetModelId: null,
        sidebarSelection: null
      };
    }

    const pageId =
      segments[2] === "pages" || segments[2] === "sites"
        ? parsePositiveInteger(segments[3])
        : null;

    return {
      kind: pageId === null ? "project" : "projectPage",
      menu: "projects",
      selectedOrganizationModelId: projectId,
      selectedEvaluationTargetModelId: pageId,
      sidebarSelection:
        pageId === null
          ? { kind: "project", id: projectId }
          : { kind: "projectPage", projectId, pageId }
    };
  }

  if (segments[0] === "recent-pages") {
    const pageId = parsePositiveInteger(segments[1]);
    if (pageId !== null) {
      return {
        kind: "recentPage",
        menu: "projects",
        selectedOrganizationModelId: null,
        selectedEvaluationTargetModelId: pageId,
        sidebarSelection: { kind: "recentPage", id: pageId }
      };
    }
  }

  return {
    kind: "analyze",
    menu: "analyze",
    selectedOrganizationModelId: null,
    selectedEvaluationTargetModelId: null,
    sidebarSelection: null
  };
}
