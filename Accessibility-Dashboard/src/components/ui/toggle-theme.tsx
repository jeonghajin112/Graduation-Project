import * as React from "react";
import { MoonStarIcon, SunIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type ThemeMode = "system" | "light" | "dark";

interface ToggleThemeProps {
  value: ThemeMode;
  onChange: (value: ThemeMode) => void;
  isDark: boolean;
}

export function ToggleTheme({ onChange, isDark }: ToggleThemeProps) {
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  const nextTheme = isDark ? "light" : "dark";
  const label = isDark ? "라이트 모드로 전환" : "다크 모드로 전환";
  const Icon = isDark ? SunIcon : MoonStarIcon;

  if (!isMounted) {
    return <div className="toggle-theme-placeholder" />;
  }

  return (
    <button
      type="button"
      className={cn(
        "toggle-theme-button inline-flex items-center justify-center rounded-full border outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-slate-300",
        isDark
          ? "border-white/12 bg-[#1a1a1a] text-white hover:bg-[#262626]"
          : "bg-white/80 text-slate-900 hover:bg-white"
      )}
      aria-label={label}
      title={label}
      onClick={() => onChange(nextTheme)}
    >
      <Icon className="toggle-theme-icon" strokeWidth={1.9} />
    </button>
  );
}
