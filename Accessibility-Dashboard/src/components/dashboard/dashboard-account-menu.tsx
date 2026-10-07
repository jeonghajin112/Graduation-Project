import { ChevronDown, LogOut, Settings } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";

import { nextMenuItemIndex } from "./menu-keyboard";

const ACCOUNT_MENU_ITEM_COUNT = 2;

type AccountMenuAnchor = "label" | "rail";

/** The account menu opened from the labelled trigger or from the collapsed rail's avatar. */
export function useAccountMenu() {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The collapsed rail hides the labelled trigger; this avatar-only button keeps
  // settings and logout reachable without expanding the sidebar.
  const railTriggerRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<AccountMenuAnchor>("label");
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialFocusIndexRef = useRef(0);
  const [isOpen, setIsOpen] = useState(false);
  const [railMenuPosition, setRailMenuPosition] = useState<CSSProperties | null>(null);

  const getTrigger = useCallback(
    () => (anchorRef.current === "rail" ? railTriggerRef.current : triggerRef.current),
    []
  );

  const open = useCallback((initialFocusIndex = 0, anchor: AccountMenuAnchor = "label") => {
    initialFocusIndexRef.current = initialFocusIndex;
    anchorRef.current = anchor;
    if (anchor === "rail") {
      const rect = railTriggerRef.current?.getBoundingClientRect();
      const isMobileRail = window.innerWidth < 768;
      setRailMenuPosition(
        rect
          ? isMobileRail
            ? { position: "fixed", left: Math.max(8, rect.left), top: rect.bottom + 6 }
            : { position: "fixed", left: rect.right + 8, top: Math.max(8, rect.top) }
          : null
      );
    } else {
      setRailMenuPosition(null);
    }
    setIsOpen(true);
  }, []);

  const close = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => {
        getTrigger()?.focus({ preventScroll: true });
      }, 0);
    }
  }, [getTrigger]);

  /** Closes with focus already on the trigger, so a dialog opened next returns it there. */
  const closeBeforeDialog = useCallback(() => {
    setIsOpen(false);
    getTrigger()?.focus({ preventScroll: true });
  }, [getTrigger]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      itemRefs.current[initialFocusIndexRef.current]?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        railTriggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      close(true);
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, isOpen]);

  const handleTriggerClick = (anchor: AccountMenuAnchor) => {
    if (isOpen) {
      close(true);
      return;
    }
    open(0, anchor);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, anchor: AccountMenuAnchor) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(0, anchor);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      open(ACCOUNT_MENU_ITEM_COUNT - 1, anchor);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      if (railMenuPosition) {
        // The rail menu lives outside the sidebar in DOM order; hand focus back
        // to its trigger instead of letting Tab jump to the top of the page.
        event.preventDefault();
        close(true);
        return;
      }
      close();
      return;
    }

    const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(event.key, currentIndex, ACCOUNT_MENU_ITEM_COUNT);
    if (nextIndex !== null) {
      event.preventDefault();
      itemRefs.current[nextIndex]?.focus({ preventScroll: true });
    }
  };

  return {
    menuId,
    isOpen,
    // The rail is paint-contained, so its menu is positioned from outside it (fixed).
    isRailMenu: isOpen && railMenuPosition !== null,
    railMenuPosition,
    triggerRef,
    railTriggerRef,
    menuRef,
    itemRefs,
    close,
    closeBeforeDialog,
    handleTriggerClick,
    handleTriggerKeyDown,
    handleMenuKeyDown
  };
}

export type AccountMenuController = ReturnType<typeof useAccountMenu>;

const MENU_ITEM_CLASS =
  "dashboard-account-menu-item flex w-full items-center rounded-lg text-left font-medium text-slate-700 outline-none transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-[var(--dashboard-accent)]/60 focus-visible:ring-inset";

export function AccountMenu({
  menu,
  isPreview,
  onOpenSettings,
  onLogout
}: {
  menu: AccountMenuController;
  isPreview: boolean;
  onOpenSettings: () => void;
  onLogout?: () => void;
}) {
  if (!menu.isOpen) {
    return null;
  }
  return (
    <div
      ref={menu.menuRef}
      id={menu.menuId}
      role="menu"
      aria-label="계정 메뉴"
      onKeyDown={menu.handleMenuKeyDown}
      style={menu.railMenuPosition ?? undefined}
      className={`dashboard-account-menu dashboard-account-menu-open z-40 origin-top rounded-2xl bg-white p-1.5 shadow-lg ${
        menu.railMenuPosition ? "" : "absolute left-0 right-auto top-full mt-1.5"
      }`}
    >
      <button
        ref={(element) => {
          menu.itemRefs.current[0] = element;
        }}
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        onClick={onOpenSettings}
      >
        <Settings size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
        설정
      </button>
      <button
        ref={(element) => {
          menu.itemRefs.current[1] = element;
        }}
        type="button"
        role="menuitem"
        aria-disabled={isPreview}
        title={isPreview ? "읽기 전용 미리보기에서는 로그아웃할 수 없습니다" : undefined}
        className={`${MENU_ITEM_CLASS} ${isPreview ? "cursor-not-allowed" : ""}`}
        onClick={() => {
          if (isPreview) {
            return;
          }
          menu.close();
          onLogout?.();
        }}
      >
        <LogOut size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
        로그아웃
      </button>
    </div>
  );
}

export function AccountMenuTrigger({ menu, userName }: { menu: AccountMenuController; userName: string }) {
  return (
    <button
      ref={menu.triggerRef}
      type="button"
      className="dashboard-account-menu-trigger w-fit min-w-0 max-w-full rounded-lg text-left outline-none transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-[var(--dashboard-accent)]/60 focus-visible:ring-offset-2"
      aria-expanded={menu.isOpen && !menu.isRailMenu}
      aria-controls={menu.menuId}
      aria-haspopup="menu"
      onClick={() => menu.handleTriggerClick("label")}
      onKeyDown={(event) => menu.handleTriggerKeyDown(event, "label")}
    >
      <span className="dashboard-account-avatar" aria-hidden="true">
        {userName.slice(0, 1)}
      </span>
      <span className="dashboard-account-name max-w-36 truncate font-bold">
        {userName}
      </span>
      <ChevronDown
        size={16}
        aria-hidden="true"
        className={`dashboard-account-menu-chevron transition-transform duration-150 ease-out ${
          menu.isOpen ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

export function AccountRailTrigger({ menu, userName }: { menu: AccountMenuController; userName: string }) {
  return (
    <button
      ref={menu.railTriggerRef}
      type="button"
      className="dashboard-account-rail-trigger"
      aria-label={`계정 메뉴 (${userName})`}
      title={userName}
      aria-expanded={menu.isRailMenu}
      aria-controls={menu.menuId}
      aria-haspopup="menu"
      onClick={() => menu.handleTriggerClick("rail")}
      onKeyDown={(event) => menu.handleTriggerKeyDown(event, "rail")}
    >
      <span className="dashboard-account-avatar" aria-hidden="true">
        {userName.slice(0, 1)}
      </span>
    </button>
  );
}
