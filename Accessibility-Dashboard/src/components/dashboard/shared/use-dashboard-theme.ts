import { useEffect, useLayoutEffect, useState } from "react";

import type { ThemeMode } from "@/types/theme";

// index.html reads the same key before first paint. Keep both in sync.
const THEME_STORAGE_KEY = "bridge-theme";
const LIGHT_THEME_COLOR = "#f5f5f7";
const DARK_THEME_COLOR = "#111113";

function setBrowserThemeColor(color: string) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "system";
  }

  try {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "dark" || savedTheme === "light") {
      return savedTheme;
    }
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // in-memory preference remains usable for the current dashboard session.
  }

  return "system";
}

export function useDashboardTheme({
  initialMode,
  persist = true
}: {
  initialMode?: ThemeMode;
  persist?: boolean;
} = {}) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    initialMode ?? (persist ? readStoredTheme() : "system")
  );
  const [prefersDark, setPrefersDark] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const isDarkMode = themeMode === "dark" || (themeMode === "system" && prefersDark);

  useEffect(() => {
    if (!persist) {
      return;
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Applying the selected theme must not depend on persistent storage.
    }
  }, [persist, themeMode]);

  // Layout effect: apply the document theme before the browser paints, so
  // client-side navigation into the dashboard never shows a light frame.
  useLayoutEffect(() => {
    const rootElement = document.documentElement;
    rootElement.classList.toggle("dark", isDarkMode);
    setBrowserThemeColor(isDarkMode ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);

    return () => {
      rootElement.classList.remove("dark");
      setBrowserThemeColor(LIGHT_THEME_COLOR);
    };
  }, [isDarkMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };

    setPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => {
      mediaQuery.removeEventListener("change", onChange);
    };
  }, []);

  return {
    isDarkMode,
    themeMode,
    setThemeMode
  };
}
