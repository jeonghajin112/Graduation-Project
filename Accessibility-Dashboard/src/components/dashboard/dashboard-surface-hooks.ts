import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { MenuType } from "@/types/accessibility-domain";

import { getFocusableElements } from "./shared/use-dialog-accessibility";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "dashboard-sidebar-collapsed";
// Matches the --dashboard-sidebar-width transition in index.css.
const SIDEBAR_SLIDE_MS = 280;

function readStoredSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * The sidebar's collapsed state, remembered per browser. The embedded landing
 * preview always starts expanded and never writes the viewer's preference.
 */
export function useSidebarCollapse(isPreview: boolean, beforeToggle: () => void) {
  const [isCollapsed, setIsCollapsed] = useState(() => !isPreview && readStoredSidebarCollapsed());

  useEffect(() => {
    if (isPreview) {
      return;
    }
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
    } catch {
      // Collapsing must keep working for this session without storage.
    }
  }, [isPreview, isCollapsed]);

  // The rail slides only when the user toggles it; a window resize changes
  // its width at once, so layout never lags behind the viewport.
  const [isSliding, setIsSliding] = useState(false);
  useEffect(() => {
    if (!isSliding) {
      return;
    }
    const timer = window.setTimeout(() => setIsSliding(false), SIDEBAR_SLIDE_MS + 40);
    return () => window.clearTimeout(timer);
  }, [isSliding, isCollapsed]);

  const toggle = useCallback(() => {
    beforeToggle();
    setIsSliding(true);
    setIsCollapsed((collapsed) => !collapsed);
  }, [beforeToggle]);

  return { isCollapsed, isSliding, toggle };
}

export function useDashboardDocumentTitle(
  isPreview: boolean,
  menu: MenuType,
  organizationName: string,
  evaluationTargetName: string
) {
  useEffect(() => {
    if (isPreview) {
      return;
    }

    const pageLabel = evaluationTargetName.length > 0
      ? `${evaluationTargetName} 접근성 분석`
      : organizationName.length > 0
        ? `${organizationName} 프로젝트`
        : menu === "projects"
          ? "프로젝트"
          : "새 페이지 분석";
    document.title = `${pageLabel} | UNI ACCESS`;
  }, [evaluationTargetName, isPreview, menu, organizationName]);
}

/**
 * Moves keyboard and screen-reader focus to the new view's heading after an
 * in-app navigation. The first settled route (initial load) is left alone so
 * the skip link stays the first Tab stop.
 */
export function useRouteHeadingFocus({
  enabled,
  routeKey,
  headingRef,
  fallbackRef
}: {
  enabled: boolean;
  routeKey: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  fallbackRef: RefObject<HTMLElement | null>;
}) {
  const previousRouteKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const previousRouteKey = previousRouteKeyRef.current;
    previousRouteKeyRef.current = routeKey;
    if (previousRouteKey === null || previousRouteKey === routeKey) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => {
      if (document.querySelector('[aria-modal="true"]')) {
        return;
      }
      const target = headingRef.current ?? fallbackRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [enabled, fallbackRef, headingRef, routeKey]);
}

/** Phones get the sidebar as a drawer; keep in sync with the 767px breakpoint in index.css. */
const MOBILE_SIDEBAR_QUERY = "(max-width: 767px)";

function matchesMobileSidebar() {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_SIDEBAR_QUERY).matches;
}

/**
 * The phone layout's navigation drawer. It belongs to the route it was opened
 * on, so following a link closes it in the same render, before route focus
 * moves to the new heading. While open, Tab stays within the menu button and
 * the drawer, Escape closes it, and the page behind is inert and does not scroll.
 */
export function useMobileSidebarDrawer({
  routeKey,
  toggleRef,
  drawerRef,
  mainRef
}: {
  routeKey: string;
  toggleRef: RefObject<HTMLButtonElement | null>;
  drawerRef: RefObject<HTMLElement | null>;
  mainRef: RefObject<HTMLElement | null>;
}) {
  const [isMobile, setIsMobile] = useState(matchesMobileSidebar);
  const [openRouteKey, setOpenRouteKey] = useState<string | null>(null);
  const isOpen = isMobile && openRouteKey === routeKey;

  useEffect(() => {
    const query = window.matchMedia(MOBILE_SIDEBAR_QUERY);
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const close = useCallback((restoreFocus: boolean) => {
    setOpenRouteKey(null);
    if (restoreFocus) {
      toggleRef.current?.focus({ preventScroll: true });
    }
  }, [toggleRef]);

  const toggle = useCallback(() => {
    setOpenRouteKey((current) => (current === routeKey ? null : routeKey));
  }, [routeKey]);

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!isOpen || !main) {
      return;
    }
    const bodyOverflow = document.body.style.overflow;
    main.inert = true;
    document.body.style.overflow = "hidden";
    return () => {
      main.inert = false;
      document.body.style.overflow = bodyOverflow;
    };
  }, [isOpen, mainRef]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const focusTimer = window.setTimeout(() => {
      const drawer = drawerRef.current;
      if (drawer) {
        getFocusableElements(drawer)[0]?.focus({ preventScroll: true });
      }
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      // A dialog opened from the drawer manages its own keys.
      if (document.querySelector('[aria-modal="true"]')) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      const drawer = drawerRef.current;
      const toggleButton = toggleRef.current;
      if (event.key !== "Tab" || !drawer || !toggleButton) {
        return;
      }
      const stops = [toggleButton, ...getFocusableElements(drawer)];
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && (drawer.contains(active) || active === toggleButton);
      if (!inside || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    };

    // Any navigation row closes the drawer, including the current page's own
    // row, which changes no route. Disclosure and "more" buttons keep it open.
    // This runs before the row's React handler, so route focus still wins; if
    // the route stays, focus moves from the now hidden row to the menu button.
    const handleNavigationClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".sidebar-nav-link")) {
        return;
      }
      setOpenRouteKey(null);
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || active === document.body || active.getClientRects().length === 0) {
          toggleRef.current?.focus({ preventScroll: true });
        }
      });
    };
    const drawer = drawerRef.current;
    drawer?.addEventListener("click", handleNavigationClick);

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      drawer?.removeEventListener("click", handleNavigationClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, drawerRef, isOpen, toggleRef]);

  return { isMobile, isOpen, toggle, close };
}
