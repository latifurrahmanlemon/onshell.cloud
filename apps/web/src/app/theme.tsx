"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "onshell-mode";

/**
 * Inline script that runs before first paint (see layout.tsx) to set
 * data-mode on <html> from localStorage or the OS preference. Kept as a string
 * so it can be injected verbatim and avoid a flash of the wrong theme.
 */
export const themeBootstrapScript = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');if(m!=='light'&&m!=='dark'){m=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-mode',m);}catch(e){document.documentElement.setAttribute('data-mode','dark');}})();`;

function readMode(): ThemeMode {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-mode");
    if (attr === "light" || attr === "dark") return attr;
  }
  return "dark";
}

export function useThemeMode() {
  // Start as "dark" to match the server render, then sync to the real value
  // after mount so hydration stays consistent.
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    setMode(readMode());
  }, []);

  const applyMode = (next: ThemeMode) => {
    setMode(next);
    document.documentElement.setAttribute("data-mode", next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // storage unavailable (private mode) — mode still applies for this session
    }
  };

  const toggle = () => applyMode(mode === "dark" ? "light" : "dark");

  return { mode, setMode: applyMode, toggle };
}

export function ThemeToggle({ className }: { className?: string }) {
  const { mode, toggle } = useThemeMode();
  const label = mode === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      aria-label={label}
      className={className ? `theme-toggle ${className}` : "theme-toggle"}
      onClick={toggle}
      title={label}
      type="button"
    >
      {mode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
