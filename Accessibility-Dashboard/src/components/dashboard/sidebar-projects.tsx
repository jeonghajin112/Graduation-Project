import { ChevronRight, FileText, Folder, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getApiErrorMessage } from "@/services/backend-api";
import type { DashboardSidebarSelection } from "@/services/dashboard-route";
import {
  buildRecentAnalyzedPages,
  getQuickAnalysisRegistryServerSnapshot,
  getQuickAnalysisRegistrySnapshot,
  subscribeQuickAnalysisRegistry,
  type QuickAnalysisResultRecord
} from "@/services/quick-analysis-registry";
import type { OrganizationModel, EvaluationRequestModel } from "@/types/accessibility-domain";
import { PageAnalysisStatus } from "./shared/page-analysis-status";
import { API_BASE_URL } from "@/config/api";

import { PanelMessage } from "./shared/display";
import { useDialogAccessibility } from "./shared/use-dialog-accessibility";

const PROJECT_MENU_WIDTH = 132;
const PROJECT_MENU_HEIGHT = 74;
const PROJECT_MENU_GAP = 4;
const PROJECT_MENU_VIEWPORT_PADDING = 8;
const EMPTY_QUICK_ANALYSIS_RESULTS: readonly QuickAnalysisResultRecord[] = [];
const subscribeStaticQuickAnalysisResults = () => () => undefined;
const ANALYSIS_ACKNOWLEDGED_KEY = `uni-access.analysis-acknowledged.v1:${API_BASE_URL}`;

function readAcknowledgedAnalyses(): Record<number, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ANALYSIS_ACKNOWLEDGED_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([target, request]) =>
      Number.isSafeInteger(Number(target)) && Number(target) > 0 &&
      Number.isSafeInteger(request) && Number(request) > 0));
  } catch { return {}; }
}

/** Shared selected/hover/focus chrome for project + recent-page sidebar rows (radius via design token, never pill). */
const SIDEBAR_NAV_ITEM_BASE =
  "sidebar-tree-row sidebar-nav-link flex w-full min-w-0 items-center rounded-[var(--dashboard-sidebar-item-radius)] border text-left transition focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--dashboard-accent)]";
const SIDEBAR_NAV_ITEM_ACTIVE = "sidebar-nav-link-active border-transparent";
const SIDEBAR_NAV_ITEM_INACTIVE =
  "border-transparent text-[var(--dashboard-sidebar-muted-text)] hover:border-[var(--dashboard-sidebar-item-hover-border)] hover:bg-[var(--dashboard-sidebar-item-hover-bg)] hover:text-[var(--dashboard-sidebar-hover-text)]";

/** Section labels only (프로젝트 / 최근 분석한 페이지): size/lh via .sidebar-section-heading tokens (8.5px/12.5px). */
const SIDEBAR_SECTION_HEADING =
  "sidebar-section-heading min-w-0 break-keep tracking-[0.01em] text-[color:var(--dashboard-text-muted)]";

export function SidebarProjectsSection({
  organizations,
  evaluationRequests = [],
  selection,
  onSelectProject,
  onSelectPage,
  onSelectRecentPage,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  quickAnalysisResultsOverride,
  readOnly = false
}: {
  organizations: OrganizationModel[];
  evaluationRequests?: EvaluationRequestModel[];
  selection: DashboardSidebarSelection | null;
  onSelectProject: (projectId: number) => void;
  onSelectPage?: (input: { projectId: number; pageId: number }) => void;
  onSelectRecentPage: (pageId: number) => void;
  onCreateProject: () => void;
  onUpdateProject: (input: { projectId: number; name: string; description: string }) => Promise<void>;
  onDeleteProject: (projectId: number) => Promise<void>;
  quickAnalysisResultsOverride?: readonly QuickAnalysisResultRecord[];
  readOnly?: boolean;
}) {
  const projects = useMemo(() => organizations.filter((organization) => !organization.systemManaged), [organizations]);
  const projectMenuElements = useRef(new Map<number, HTMLDivElement>());
  const projectMenuTriggers = useRef(new Map<number, HTMLButtonElement>());
  const [editingProject, setEditingProject] = useState<OrganizationModel | null>(null);
  const [editName, setEditName] = useState("");
  const [editError, setEditError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const saveLockRef = useRef(false);
  const activeSaveOperationIdRef = useRef<symbol | null>(null);
  const [deletingProject, setDeletingProject] = useState<OrganizationModel | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteLockRef = useRef(false);
  const activeDeleteOperationIdRef = useRef<symbol | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(() => new Set());
  const [acknowledgedAnalyses, setAcknowledgedAnalyses] = useState(readAcknowledgedAnalyses);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ANALYSIS_ACKNOWLEDGED_KEY || event.key === null) setAcknowledgedAnalyses(readAcknowledgedAnalyses());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const acknowledgeAnalysis = (request: EvaluationRequestModel) => {
    const next = { ...readAcknowledgedAnalyses(), ...acknowledgedAnalyses, [request.evaluationTargetId]: request.id };
    setAcknowledgedAnalyses(next);
    try { localStorage.setItem(ANALYSIS_ACKNOWLEDGED_KEY, JSON.stringify(next)); } catch { /* Keep the dismissal for this session. */ }
  };
  const pageAnalysisRequests = useMemo(() => {
    const priority = (request: EvaluationRequestModel) => request.status === "IN_PROGRESS" ? 2 : request.status === "PENDING" ? 1 : 0;
    const sorted = [...evaluationRequests].sort((a, b) => priority(b) - priority(a) || Date.parse(b.requestedAt) - Date.parse(a.requestedAt) || b.id - a.id);
    const byTarget = new Map<number, EvaluationRequestModel>();
    for (const request of sorted) if (!byTarget.has(request.evaluationTargetId)) byTarget.set(request.evaluationTargetId, request);
    return byTarget;
  }, [evaluationRequests]);
  const autoExpandedPageProjectId = useRef<number | null>(null);
  const hasQuickAnalysisResultsOverride = quickAnalysisResultsOverride !== undefined;
  const staticQuickAnalysisResults = quickAnalysisResultsOverride ?? EMPTY_QUICK_ANALYSIS_RESULTS;
  const quickAnalysisResults = useSyncExternalStore(
    hasQuickAnalysisResultsOverride
      ? subscribeStaticQuickAnalysisResults
      : subscribeQuickAnalysisRegistry,
    hasQuickAnalysisResultsOverride
      ? () => staticQuickAnalysisResults
      : getQuickAnalysisRegistrySnapshot,
    hasQuickAnalysisResultsOverride
      ? () => staticQuickAnalysisResults
      : getQuickAnalysisRegistryServerSnapshot
  );
  const recentAnalyzedPages = useMemo(
    () =>
      buildRecentAnalyzedPages({
        organizations,
        quickAnalysisResults,
        evaluationRequests
      }),
    [organizations, quickAnalysisResults, evaluationRequests]
  );
  const selectedPageProjectId = selection?.kind === "projectPage" ? selection.projectId : null;

  useEffect(
    () => () => {
      activeSaveOperationIdRef.current = null;
      saveLockRef.current = false;
      activeDeleteOperationIdRef.current = null;
      deleteLockRef.current = false;
    },
    []
  );

  useEffect(() => {
    const availableProjectIds = new Set(organizations.map((project) => project.id));

    setExpandedProjectIds((current) => {
      const next = new Set([...current].filter((projectId) => availableProjectIds.has(projectId)));

      if (next.size === current.size && [...next].every((projectId) => current.has(projectId))) {
        return current;
      }
      return next;
    });
  }, [organizations]);

  useEffect(() => {
    if (selectedPageProjectId === null) {
      autoExpandedPageProjectId.current = null;
      return;
    }

    const selectedProjectExists = organizations.some((project) => project.id === selectedPageProjectId);
    if (!selectedProjectExists || autoExpandedPageProjectId.current === selectedPageProjectId) {
      return;
    }

    autoExpandedPageProjectId.current = selectedPageProjectId;
    setExpandedProjectIds((current) => {
      if (current.has(selectedPageProjectId)) {
        return current;
      }

      const next = new Set(current);
      next.add(selectedPageProjectId);
      return next;
    });
  }, [organizations, selectedPageProjectId]);

  const closeEdit = () => {
    if (saveLockRef.current) {
      return;
    }
    setEditingProject(null);
    setEditError("");
  };

  const closeDelete = () => {
    if (deleteLockRef.current) {
      return;
    }
    setDeletingProject(null);
    setDeleteError("");
  };

  const editDialogRef = useDialogAccessibility({
    isOpen: editingProject !== null,
    onClose: closeEdit,
    closeDisabled: isSaving
  });
  const deleteDialogRef = useDialogAccessibility({
    isOpen: deletingProject !== null,
    onClose: closeDelete,
    closeDisabled: isDeleting
  });

  const openEdit = (project: OrganizationModel) => {
    projectMenuElements.current.get(project.id)?.hidePopover();
    setEditingProject(project);
    setEditName(project.name);
    setEditError("");
  };

  const openDelete = (project: OrganizationModel) => {
    projectMenuElements.current.get(project.id)?.hidePopover();
    setDeletingProject(project);
    setDeleteError("");
  };

  const handleSave = async () => {
    if (saveLockRef.current || !editingProject) {
      return;
    }

    const project = editingProject;
    const name = editName.trim();
    if (name.length === 0) {
      setEditError("프로젝트 이름은 필수입니다.");
      return;
    }

    saveLockRef.current = true;
    const operationId = Symbol("sidebar-project-save");
    activeSaveOperationIdRef.current = operationId;
    setIsSaving(true);
    setEditError("");
    try {
      await onUpdateProject({
        projectId: project.id,
        name,
        description: project.description
      });
      if (activeSaveOperationIdRef.current === operationId) {
        setEditingProject(null);
      }
    } catch (error) {
      if (activeSaveOperationIdRef.current === operationId) {
        setEditError(getApiErrorMessage(error, "프로젝트를 수정하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      }
    } finally {
      if (activeSaveOperationIdRef.current === operationId) {
        activeSaveOperationIdRef.current = null;
        saveLockRef.current = false;
        setIsSaving(false);
      }
    }
  };

  const handleDelete = async () => {
    if (deleteLockRef.current || !deletingProject) {
      return;
    }

    const project = deletingProject;
    deleteLockRef.current = true;
    const operationId = Symbol("sidebar-project-delete");
    activeDeleteOperationIdRef.current = operationId;
    setIsDeleting(true);
    setDeleteError("");
    try {
      await onDeleteProject(project.id);
      if (activeDeleteOperationIdRef.current === operationId) {
        setDeletingProject(null);
      }
    } catch (error) {
      if (activeDeleteOperationIdRef.current === operationId) {
        setDeleteError(getApiErrorMessage(error, "프로젝트를 제거하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      }
    } finally {
      if (activeDeleteOperationIdRef.current === operationId) {
        activeDeleteOperationIdRef.current = null;
        deleteLockRef.current = false;
        setIsDeleting(false);
      }
    }
  };

  const showProjectMenu = (projectId: number, preferredLeft: number, preferredTop: number) => {
    const menuElement = projectMenuElements.current.get(projectId);
    if (!menuElement) {
      return;
    }

    const maxLeft = Math.max(
      PROJECT_MENU_VIEWPORT_PADDING,
      window.innerWidth - PROJECT_MENU_WIDTH - PROJECT_MENU_VIEWPORT_PADDING
    );
    const maxTop = Math.max(
      PROJECT_MENU_VIEWPORT_PADDING,
      window.innerHeight - PROJECT_MENU_HEIGHT - PROJECT_MENU_VIEWPORT_PADDING
    );

    menuElement.style.left = `${Math.max(PROJECT_MENU_VIEWPORT_PADDING, Math.min(preferredLeft, maxLeft))}px`;
    menuElement.style.top = `${Math.max(PROJECT_MENU_VIEWPORT_PADDING, Math.min(preferredTop, maxTop))}px`;

    if (!menuElement.matches(":popover-open")) {
      menuElement.showPopover();
    }
  };

  return (
    <section className="sidebar-tree-section flex min-h-0 flex-col">
      <div className="sidebar-tree-section-header flex items-center gap-2">
        <p className={SIDEBAR_SECTION_HEADING}>프로젝트</p>
        <button
          type="button"
          onClick={onCreateProject}
          disabled={readOnly}
          className="sidebar-tree-add ml-auto inline-flex shrink-0 items-center justify-center transition disabled:cursor-not-allowed"
          aria-label="프로젝트 추가"
          title={readOnly ? "읽기 전용 미리보기에서는 프로젝트를 추가할 수 없습니다" : "프로젝트 추가"}
        >
          <Plus size={14} strokeWidth={2.2} />
        </button>
      </div>

      <div className="sidebar-tree-projects min-h-0 overflow-y-auto">
        {projects.length > 0 ? (
          <ul className="sidebar-tree-list flex flex-col">
            {projects.map((project) => {
              const isActive = selection?.kind === "project" && selection.id === project.id;
              const isExpanded = expandedProjectIds.has(project.id);
              const childListId = `sidebar-project-pages-${project.id}`;
              const menuId = `sidebar-project-menu-${project.id}`;

              return (
                <li key={project.id}>
                  <div className="group relative">
                    <button
                      ref={(element) => {
                        if (element) {
                          projectMenuTriggers.current.set(project.id, element);
                        } else {
                          projectMenuTriggers.current.delete(project.id);
                        }
                      }}
                      type="button"
                      onClick={() => {
                        setExpandedProjectIds((current) => {
                          const next = new Set(current);
                          if (next.has(project.id)) {
                            next.delete(project.id);
                          } else {
                            next.add(project.id);
                          }
                          return next;
                        });
                        onSelectProject(project.id);
                      }}
                      onContextMenu={(event) => {
                        if (readOnly) {
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        showProjectMenu(project.id, event.clientX, event.clientY);
                      }}
                      onKeyDown={(event) => {
                        if (
                          readOnly ||
                          (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                        ) {
                          return;
                        }

                        event.preventDefault();
                        event.stopPropagation();
                        const triggerRect = event.currentTarget.getBoundingClientRect();
                        showProjectMenu(
                          project.id,
                          triggerRect.right - PROJECT_MENU_WIDTH,
                          triggerRect.bottom + PROJECT_MENU_GAP
                        );
                      }}
                      aria-keyshortcuts={readOnly ? undefined : "Shift+F10"}
                      aria-expanded={isExpanded}
                      aria-controls={childListId}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        SIDEBAR_NAV_ITEM_BASE,
                        "sidebar-tree-parent-row",
                        isActive ? SIDEBAR_NAV_ITEM_ACTIVE : SIDEBAR_NAV_ITEM_INACTIVE
                      )}
                      title={project.name}
                    >
                      <span className="sidebar-tree-chevron inline-flex shrink-0 items-center justify-center">
                        <ChevronRight
                          size={13}
                          aria-hidden="true"
                          className={cn(
                            "transition-transform duration-150 ease-out motion-reduce:transition-none",
                            isExpanded && "rotate-90"
                          )}
                        />
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="sidebar-tree-folder-icon inline-flex shrink-0 items-center justify-center">
                          {isExpanded ? (
                            <FolderOpen size={15} aria-hidden="true" />
                          ) : (
                            <Folder size={15} aria-hidden="true" />
                          )}
                        </span>
                        <span className="sidebar-tree-label min-w-0 flex-1 truncate font-medium">{project.name}</span>
                      </span>
                    </button>

                   {!readOnly ? <div
                    ref={(element) => {
                      if (!element) {
                        projectMenuElements.current.delete(project.id);
                        return;
                      }

                      element.popover = "auto";
                      element.ontoggle = (event) => {
                        const isOpen = (event as ToggleEvent).newState === "open";
                        if (isOpen) {
                          window.requestAnimationFrame(() =>
                            element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true })
                          );
                        } else if (document.activeElement === document.body) {
                          projectMenuTriggers.current.get(project.id)?.focus({ preventScroll: true });
                        }
                      };
                      projectMenuElements.current.set(project.id, element);
                    }}
                    id={menuId}
                    role="menu"
                    aria-label={`${project.name} 관리`}
                    className={cn(
                      "fixed inset-auto m-0 min-w-[132px] overflow-hidden rounded-xl border border-[var(--dashboard-nested-border)] bg-[var(--report-search-popover-bg)] px-0 py-1 text-[var(--dashboard-text-primary)] shadow-[var(--dashboard-header-shadow)]"
                    )}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openEdit(project)}
                      className={cn(
                        "sidebar-project-context-menu-item mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium text-[var(--dashboard-text-primary)] transition-colors hover:bg-[var(--dashboard-hover-surface)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px]"
                      )}
                    >
                      <Pencil size={13} />
                      수정
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openDelete(project)}
                      className={cn(
                        "sidebar-project-context-menu-item sidebar-project-context-menu-item-destructive mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium transition-colors hover:bg-[var(--dashboard-hover-surface)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px]"
                      )}
                    >
                      <Trash2 size={13} />
                      삭제
                    </button>
                   </div> : null}
                  </div>

                  {isExpanded ? (
                    <ul id={childListId} className="sidebar-tree-children flex flex-col">
                      {project.evaluationTargets.map((page) => {
                        const analysis = pageAnalysisRequests.get(page.id);
                        const isPageActive =
                          selection?.kind === "projectPage" &&
                          selection.projectId === project.id &&
                          selection.pageId === page.id;

                        return (
                          <li key={page.id} className="relative">
                            {readOnly ? (
                              <button
                                type="button"
                                aria-current={isPageActive ? "page" : undefined}
                                aria-label={`${page.name} 페이지 열기 (${project.name} 프로젝트)`}
                                title={`${page.name} · ${project.name}`}
                                onClick={() => onSelectPage?.({ projectId: project.id, pageId: page.id })}
                                className={cn(
                                  SIDEBAR_NAV_ITEM_BASE,
                                  "sidebar-tree-child-row pr-8",
                                  isPageActive ? SIDEBAR_NAV_ITEM_ACTIVE : SIDEBAR_NAV_ITEM_INACTIVE
                                )}
                              >
                                <span className="sidebar-tree-page-icon inline-flex shrink-0 items-center justify-center">
                                  <FileText size={16} aria-hidden="true" />
                                </span>
                                <span className="sidebar-tree-label min-w-0 flex-1 truncate font-medium">{page.name}</span>
                              </button>
                            ) : (
                              <Link
                                to={`/projects/${project.id}/pages/${page.id}`}
                                onClick={() => {
                                  if (analysis?.status === "COMPLETED") acknowledgeAnalysis(analysis);
                                }}
                                aria-current={isPageActive ? "page" : undefined}
                                aria-label={`${page.name} 페이지 열기 (${project.name} 프로젝트)`}
                                title={`${page.name} · ${project.name}`}
                                className={cn(
                                  SIDEBAR_NAV_ITEM_BASE,
                                  "sidebar-tree-child-row pr-8",
                                  isPageActive ? SIDEBAR_NAV_ITEM_ACTIVE : SIDEBAR_NAV_ITEM_INACTIVE
                                )}
                              >
                                <span className="sidebar-tree-page-icon inline-flex shrink-0 items-center justify-center">
                                  <FileText size={16} aria-hidden="true" />
                                </span>
                                <span className="sidebar-tree-label min-w-0 flex-1 truncate font-medium">{page.name}</span>
                              </Link>
                            )}
                            {!readOnly && <PageAnalysisStatus request={analysis} pageName={page.name}
                              acknowledged={!!analysis && acknowledgedAnalyses[page.id] === analysis.id} />}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <div className="sidebar-tree-recent flex flex-col">
        <div className="sidebar-tree-section-header flex items-center gap-2">
          <p className={SIDEBAR_SECTION_HEADING}>최근 분석한 페이지</p>
        </div>
        <div className="sidebar-tree-recent-list flex flex-col">
          {recentAnalyzedPages.length === 0 ? (
            <p className="sidebar-tree-empty-copy">분석한 페이지가 없습니다.</p>
          ) : (
            recentAnalyzedPages.map((page) => {
              const isActive = selection?.kind === "recentPage" && selection.id === page.pageId;
              const contextLabel = page.systemManaged
                ? `${page.pageName} 페이지 열기 (최근 분석)`
                : `${page.pageName} 페이지 열기 (${page.projectName} 프로젝트)`;
              const analysis = pageAnalysisRequests.get(page.pageId);

              return (
                <button
                  key={page.pageId}
                  type="button"
                  aria-label={contextLabel}
                  aria-current={isActive ? "page" : undefined}
                  title={page.systemManaged ? page.pageName : `${page.pageName} · ${page.projectName}`}
                  onClick={() => {
                    if (!readOnly && analysis?.status === "COMPLETED") acknowledgeAnalysis(analysis);
                    onSelectRecentPage(page.pageId);
                  }}
                  className={cn(
                    SIDEBAR_NAV_ITEM_BASE,
                    "sidebar-tree-child-row relative pr-8",
                    isActive ? SIDEBAR_NAV_ITEM_ACTIVE : SIDEBAR_NAV_ITEM_INACTIVE
                  )}
                >
                  <span className="sidebar-tree-page-icon inline-flex shrink-0 items-center justify-center">
                    <FileText size={16} aria-hidden="true" />
                  </span>
                  <span className="sidebar-tree-label min-w-0 flex-1 truncate font-medium">{page.pageName}</span>
                  {!readOnly && <PageAnalysisStatus request={analysis} pageName={page.pageName}
                    acknowledged={analysis !== undefined && acknowledgedAnalyses[page.pageId] === analysis.id} />}
                </button>
              );
            })
          )}
        </div>
      </div>

      {editingProject
        ? createPortal(
            <div className="dashboard-modal-layer">
              <div className="absolute inset-0" onClick={closeEdit} aria-hidden="true" />
              <article
                ref={editDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="sidebar-project-edit-title"
                tabIndex={-1}
                className="dashboard-modal-surface dashboard-modal-content w-full max-w-md"
              >
                <h3
                  id="sidebar-project-edit-title"
                  className="dashboard-modal-title"
                >
                  프로젝트 수정
                </h3>

                {editError.length > 0 && <PanelMessage className="dashboard-modal-message" label={`프로젝트 수정 실패: ${editError}`} isError />}

                <div className="mt-4 space-y-4">
                  <label className="block">
                    <span className="dashboard-modal-label">
                      프로젝트 이름
                    </span>
                    <input
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      className="dashboard-modal-input"
                      placeholder="예: 고령자 접근성 점검"
                    />
                  </label>
                </div>

                <div className="dashboard-modal-actions">
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={closeEdit}
                    className="dashboard-modal-button"
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => {
                      void handleSave();
                    }}
                    className="dashboard-modal-button dashboard-modal-button--primary"
                  >
                    {isSaving ? "저장 중..." : "저장"}
                  </button>
                </div>
              </article>
            </div>,
            document.body
          )
        : null}

      {deletingProject
        ? createPortal(
            <div className="dashboard-modal-layer">
              <div className="absolute inset-0" onClick={closeDelete} aria-hidden="true" />
              <article
                ref={deleteDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="sidebar-project-delete-title"
                tabIndex={-1}
                className="dashboard-modal-surface dashboard-modal-content w-full max-w-md"
              >
                <h3
                  id="sidebar-project-delete-title"
                  className="dashboard-modal-title"
                >
                  프로젝트 제거
                </h3>
                <p className="dashboard-modal-description mt-2">
                  <span className="font-medium text-foreground">
                    {deletingProject.name}
                  </span>{" "}
                  프로젝트를 제거하시겠습니까?
                </p>

                {deleteError.length > 0 && <PanelMessage className="dashboard-modal-message" label={`프로젝트 제거 실패: ${deleteError}`} isError />}

                <div className="dashboard-modal-actions">
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={closeDelete}
                    className="dashboard-modal-button"
                  >
                    아니요
                  </button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => {
                      void handleDelete();
                    }}
                    className="dashboard-modal-button dashboard-modal-button--danger"
                  >
                    {isDeleting ? "제거 중..." : "네"}
                  </Button>
                </div>
              </article>
            </div>,
            document.body
          )
        : null}
    </section>
  );
}
