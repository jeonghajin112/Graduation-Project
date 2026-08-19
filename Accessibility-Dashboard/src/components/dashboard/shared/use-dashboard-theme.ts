import { useEffect, useState } from "react";

import type { ThemeMode } from "@/components/ui/toggle-theme";

export function useDashboardTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") {
      return "system";
    }

    const savedTheme = window.localStorage.getItem("bridge-theme");
    if (savedTheme === "dark") {
      return "dark";
    }
    if (savedTheme === "light") {
      return "light";
    }
    return "system";
  });
  const [prefersDark, setPrefersDark] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const isDarkMode = themeMode === "dark" || (themeMode === "system" && prefersDark);

  useEffect(() => {
    window.localStorage.setItem("bridge-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
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
