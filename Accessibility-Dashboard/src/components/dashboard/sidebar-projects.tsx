import { ChevronRight, FileText, Folder, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";
import { getApiErrorMessage } from "@/services/backend-api";
import type { DashboardSidebarSelection } from "@/services/dashboard-route";
import {
  buildRecentAnalyzedPages,
  getQuickAnalysisRegistryServerSnapshot,
  getQuickAnalysisRegistrySnapshot,
  subscribeQuickAnalysisRegistry
} from "@/services/quick-analysis-registry";
import type { OrganizationModel } from "@/types/accessibility-domain";

import { PanelMessage } from "./shared/display";
import { useDialogAccessibility } from "./shared/use-dialog-accessibility";

const PROJECT_MENU_WIDTH = 132;
const PROJECT_MENU_HEIGHT = 74;
const PROJECT_MENU_GAP = 4;
const PROJECT_MENU_VIEWPORT_PADDING = 8;

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
  selection,
  isDarkMode,
  onSelectProject,
  onSelectRecentPage,
  onCreateProject,
  onUpdateProject,
  onDeleteProject
}: {
  organizations: OrganizationModel[];
  selection: DashboardSidebarSelection | null;
  isDarkMode: boolean;
  onSelectProject: (projectId: number) => void;
  onSelectRecentPage: (pageId: number) => void;
  onCreateProject: () => void;
  onUpdateProject: (input: { projectId: number; name: string; description: string }) => Promise<void>;
  onDeleteProject: (projectId: number) => Promise<void>;
}) {
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
  const autoExpandedPageProjectId = useRef<number | null>(null);
  const quickAnalysisResults = useSyncExternalStore(
    subscribeQuickAnalysisRegistry,
    getQuickAnalysisRegistrySnapshot,
    getQuickAnalysisRegistryServerSnapshot
  );
  const recentAnalyzedPages = useMemo(
    () =>
      buildRecentAnalyzedPages({
        organizations,
        quickAnalysisResults
      }),
    [organizations, quickAnalysisResults]
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
        setEditError(getApiErrorMessage(error, "프로젝트 수정 중 오류가 발생했습니다."));
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
        setDeleteError(getApiErrorMessage(error, "프로젝트 제거 중 오류가 발생했습니다."));
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
          className="sidebar-tree-add ml-auto inline-flex shrink-0 items-center justify-center transition"
          aria-label="프로젝트 추가"
          title="프로젝트 추가"
        >
          <Plus size={14} strokeWidth={2.2} />
        </button>
      </div>

      <div className="sidebar-tree-projects min-h-0 overflow-y-auto">
        {organizations.length > 0 ? (
          <ul className="sidebar-tree-list flex flex-col">
            {organizations.map((project) => {
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
                        event.preventDefault();
                        event.stopPropagation();
                        showProjectMenu(project.id, event.clientX, event.clientY);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
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
                      aria-keyshortcuts="Shift+F10"
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

                  <div
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
                        "sidebar-project-context-menu-item mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium text-[var(--dashboard-text-primary)] transition-colors hover:bg-[var(--dashboard-hover-surface)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px]"
                      )}
                    >
                      <Trash2 size={13} />
                      삭제
                    </button>
                  </div>
                  </div>

                  {isExpanded ? (
                    <ul id={childListId} className="sidebar-tree-children flex flex-col">
                      {project.evaluationTargets.map((page) => {
                        const isPageActive =
                          selection?.kind === "projectPage" &&
                          selection.projectId === project.id &&
                          selection.pageId === page.id;

                        return (
                          <li key={page.id}>
                            <Link
                              to={`/projects/${project.id}/pages/${page.id}`}
                              aria-current={isPageActive ? "page" : undefined}
                              aria-label={`${page.name} 페이지 열기 (${project.name} 프로젝트)`}
                              title={`${page.name} · ${project.name}`}
                              className={cn(
                                SIDEBAR_NAV_ITEM_BASE,
                                "sidebar-tree-child-row",
                                isPageActive ? SIDEBAR_NAV_ITEM_ACTIVE : SIDEBAR_NAV_ITEM_INACTIVE
                              )}
                            >
                              <span className="sidebar-tree-page-icon inline-flex shrink-0 items-center justify-center">
                                <FileText size={16} aria-hidden="true" />
                              </span>
                              <span className="sidebar-tree-label min-w-0 flex-1 truncate font-medium">{page.name}</span>
                            </Link>
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
              const contextLabel = `${page.pageName} 페이지 열기 (${page.projectName} 프로젝트)`;

              return (
                <button
                  key={page.pageId}
                  type="button"
                  aria-label={contextLabel}
                  aria-current={isActive ? "page" : undefined}
                  title={`${page.pageName} · ${page.projectName}`}
                  onClick={() => onSelectRecentPage(page.pageId)}
                  className={cn(
                    SIDEBAR_NAV_ITEM_BASE,
                    "sidebar-tree-child-row",
                    isActive ? SIDEBAR_NAV_ITEM_ACTIVE : SIDEBAR_NAV_ITEM_INACTIVE
                  )}
                >
                  <span className="sidebar-tree-page-icon inline-flex shrink-0 items-center justify-center">
                    <FileText size={16} aria-hidden="true" />
                  </span>
                  <span className="sidebar-tree-label min-w-0 flex-1 truncate font-medium">{page.pageName}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {editingProject
        ? createPortal(
            <div className="dashboard-modal-layer fixed inset-0 flex items-center justify-center bg-black/55 px-4 py-6 backdrop-blur-sm">
              <div className="absolute inset-0" onClick={closeEdit} />
              <article
                ref={editDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="sidebar-project-edit-title"
                tabIndex={-1}
                className={cn(
                  "relative z-10 w-full max-w-xl rounded-2xl border p-5",
                  isDarkMode ? "border-[#222222] bg-black" : "border-slate-200 bg-white"
                )}
              >
                <h3
                  id="sidebar-project-edit-title"
                  className={cn("text-lg font-semibold", isDarkMode ? "text-white" : "text-slate-900")}
                >
                  프로젝트 수정
                </h3>
                <p className={cn("mt-1 text-sm", isDarkMode ? "text-slate-400" : "text-slate-500")}>
                  프로젝트 이름을 수정할 수 있습니다.
                </p>

                {editError.length > 0 && <PanelMessage label={`프로젝트 수정 실패: ${editError}`} isError />}

                <div className="mt-4 space-y-4">
                  <label className="block">
                    <span className={cn("mb-1 block text-sm font-semibold", isDarkMode ? "text-slate-300" : "text-slate-700")}>
                      프로젝트 이름
                    </span>
                    <input
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      className={cn(
                        "h-10 w-full rounded-lg border px-3 text-sm outline-none",
                        isDarkMode
                          ? "border-[#222222] bg-[#111111] text-white placeholder:text-slate-500 focus:border-slate-500"
                          : "border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-slate-400"
                      )}
                      placeholder="예: 고령자 접근성 점검"
                    />
                  </label>
                </div>

                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={closeEdit}
                    className={cn(
                      "inline-flex h-9 items-center rounded-lg px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60",
                      isDarkMode
                        ? "bg-[#1a1a1a] font-semibold text-white hover:bg-[#262626]"
                        : "border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50"
                    )}
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => {
                      void handleSave();
                    }}
                    className="inline-flex h-9 items-center rounded-lg bg-[#ef6a50] px-3 text-sm font-semibold text-white hover:bg-[#e85d43] disabled:cursor-not-allowed disabled:opacity-60"
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
            <div className="dashboard-modal-layer fixed inset-0 flex items-center justify-center bg-black/55 px-4 py-6 backdrop-blur-sm">
              <div className="absolute inset-0" onClick={closeDelete} />
              <article
                ref={deleteDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="sidebar-project-delete-title"
                tabIndex={-1}
                className={cn(
                  "relative z-10 w-full max-w-md rounded-2xl border p-5",
                  isDarkMode ? "border-[#222222] bg-black" : "border-slate-200 bg-white"
                )}
              >
                <h3
                  id="sidebar-project-delete-title"
                  className={cn("text-lg font-semibold", isDarkMode ? "text-white" : "text-slate-900")}
                >
                  프로젝트 제거
                </h3>
                <p className={cn("mt-2 text-sm", isDarkMode ? "text-slate-400" : "text-slate-500")}>
                  <span className={cn("font-medium", isDarkMode ? "text-slate-200" : "text-slate-700")}>
                    {deletingProject.name}
                  </span>{" "}
                  프로젝트를 제거하시겠습니까?
                </p>

                {deleteError.length > 0 && <PanelMessage label={`프로젝트 제거 실패: ${deleteError}`} isError />}

                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={closeDelete}
                    className={cn(
                      "inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60",
                      isDarkMode
                        ? "border-[#222222] bg-[#111111] text-neutral-200 hover:bg-[#1a1a1a]"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    )}
                  >
                    아니요
                  </button>
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => {
                      void handleDelete();
                    }}
                    className="inline-flex h-9 items-center rounded-lg bg-rose-600 px-3 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isDeleting ? "제거 중..." : "네"}
                  </button>
                </div>
              </article>
            </div>,
            document.body
          )
        : null}
    </section>
  );
}
