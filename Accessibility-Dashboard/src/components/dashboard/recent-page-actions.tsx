import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { getApiErrorMessage } from "@/services/backend-api";
import type { RecentAnalyzedPage } from "@/services/quick-analysis-registry";
import type { ProjectPageActions } from "./dashboard-surface.types";
import { handleMenuArrowKeys, openAfterContextMenuRelease } from "./menu-keyboard";
import { PanelMessage } from "./shared/display";
import { useDialogAccessibility } from "./shared/use-dialog-accessibility";

const MENU_WIDTH = 140;

export function RecentPageActions({ page, onDelete, children }: {
  page: RecentAnalyzedPage;
  onDelete?: ProjectPageActions["onDeleteEvaluationTargetModel"];
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const titleId = useId();
  const menuId = useId();
  const close = () => {
    if (!busyRef.current) setConfirming(false);
  };
  // A deleted page takes its row (the opener) with it; continue from the
  // remaining recent list instead of dropping focus onto <body>.
  const getFallbackFocus = useCallback(
    () => document.querySelector<HTMLElement>("aside .sidebar-tree-recent-list button"),
    []
  );
  const dialogRef = useDialogAccessibility({
    isOpen: confirming, onClose: close, closeDisabled: busy, returnFocusRef: triggerRef, getFallbackFocus
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const positionMenu = (left: number, top: number) => {
    const menu = menuRef.current;
    if (!menu) return null;
    menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH))}px`;
    menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - 48))}px`;
    return menu;
  };

  const showMenu = (left: number, top: number) => {
    if (confirming) return;
    triggerRef.current = rowRef.current?.querySelector<HTMLButtonElement>("button") ?? null;
    const menu = positionMenu(left, top);
    if (!menu) return;
    if (!menu.matches(":popover-open")) menu.showPopover();
    menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  };

  const remove = async () => {
    if (!onDelete || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onDelete({ projectId: page.projectId, siteId: page.pageId });
      if (mountedRef.current) setConfirming(false);
    } catch (cause) {
      if (mountedRef.current) setError(getApiErrorMessage(cause, "페이지를 삭제하지 못했습니다. 다시 시도해 주세요."));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return <div ref={rowRef} className={onDelete ? "sidebar-row-has-more relative" : "relative"}
    onContextMenu={onDelete ? (event) => {
      event.preventDefault();
      event.stopPropagation();
      const { clientX, clientY } = event;
      openAfterContextMenuRelease(event, () => showMenu(clientX, clientY));
    } : undefined}
    onKeyDown={onDelete ? (event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      showMenu(rect.left, rect.bottom + 4);
    } : undefined}
  >
    {children}
    {onDelete && <button
      ref={(element) => element?.setAttribute("popovertarget", menuId)}
      type="button"
      className="sidebar-row-more"
      aria-label={`${page.pageName} 관리 메뉴`}
      aria-haspopup="menu"
      aria-expanded={isMenuOpen}
      aria-controls={menuId}
      title={`${page.pageName} 관리`}
      onClick={(event) => {
        // Runs before the native popovertarget toggle opens the menu.
        triggerRef.current = event.currentTarget;
        const rect = event.currentTarget.getBoundingClientRect();
        positionMenu(rect.right - MENU_WIDTH + 8, rect.bottom + 4);
      }}
    >
      <MoreHorizontal size={14} aria-hidden="true" />
    </button>}
    {onDelete && <div ref={(element) => {
      menuRef.current = element;
      if (!element) return;
      element.popover = "auto";
      element.ontoggle = (event) => {
        const open = (event as ToggleEvent).newState === "open";
        setIsMenuOpen(open);
        if (open) {
          window.requestAnimationFrame(() =>
            element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true })
          );
        }
      };
    }} id={menuId} role="menu" aria-label={`${page.pageName} 관리`}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          menuRef.current?.hidePopover();
          triggerRef.current?.focus({ preventScroll: true });
          return;
        }
        handleMenuArrowKeys(event);
      }}
      className="fixed inset-auto m-0 min-w-[132px] overflow-hidden rounded-xl border border-[var(--dashboard-nested-border)] bg-[var(--report-search-popover-bg)] px-0 py-1 text-[var(--dashboard-text-primary)] shadow-[var(--dashboard-header-shadow)]"
    >
      <button type="button" role="menuitem" onClick={() => {
        menuRef.current?.hidePopover();
        setError("");
        setConfirming(true);
      }} className="sidebar-project-context-menu-item sidebar-project-context-menu-item-destructive mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium transition-colors hover:bg-[var(--dashboard-hover-surface)] focus-visible:outline-2 focus-visible:outline-offset-[-2px]">
        <Trash2 size={13} aria-hidden="true" />삭제
      </button>
    </div>}
    {confirming && createPortal(<div className="dashboard-modal-layer">
      <div className="absolute inset-0" onClick={close} aria-hidden="true" />
      <article ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex={-1} className="dashboard-modal-surface dashboard-modal-content w-full max-w-md">
        <h3 id={titleId} className="dashboard-modal-title">페이지 삭제</h3>
        <p className="dashboard-modal-description mt-2">
          <span className="font-medium text-foreground">{page.pageName}</span> 페이지를 삭제하시겠습니까?
          <br />{page.systemManaged
            ? "최근 분석한 페이지 목록에서 제거됩니다."
            : "프로젝트에 등록된 페이지도 함께 제거됩니다."}
        </p>
        {error && <PanelMessage className="dashboard-modal-message" label={`페이지 삭제 실패: ${error}`} isError />}
        <div className="dashboard-modal-actions">
          <button type="button" disabled={busy} onClick={close} className="dashboard-modal-button">취소</button>
          <button type="button" disabled={busy} onClick={() => { void remove(); }}
            className="dashboard-modal-button dashboard-modal-button--danger">{busy ? "삭제 중..." : "삭제"}</button>
        </div>
      </article>
    </div>, document.body)}
  </div>;
}
