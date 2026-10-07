import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { MenuType } from "@/types/accessibility-domain";

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
