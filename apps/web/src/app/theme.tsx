"use client";

import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export type ThemeMode = "light" | "dark";

/** An accent is either a preset key ("violet") or a custom "#rrggbb" hex. */
export type AccentValue = string;

export const THEME_STORAGE_KEY = "onshell-mode";
export const ACCENT_STORAGE_KEY = "onshell-accent";
export const ACCENT_VARS_KEY = "onshell-accent-vars";

/** The default preset uses the hand-tuned tokens baked into globals.css. */
export const DEFAULT_ACCENT = "indigo";

export interface AccentPreset {
  key: string;
  label: string;
  hex: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { key: "indigo", label: "Indigo", hex: "#6366f1" },
  { key: "violet", label: "Violet", hex: "#8b5cf6" },
  { key: "blue", label: "Blue", hex: "#3b82f6" },
  { key: "cyan", label: "Cyan", hex: "#06b6d4" },
  { key: "emerald", label: "Emerald", hex: "#10b981" },
  { key: "amber", label: "Amber", hex: "#f59e0b" },
  { key: "rose", label: "Rose", hex: "#f43f5e" },
  { key: "fuchsia", label: "Fuchsia", hex: "#d946ef" }
];

/** Every CSS custom property the accent engine can override on <html>. */
const ACCENT_VAR_KEYS = [
  "--accent",
  "--accent-hover",
  "--accent-text",
  "--on-accent",
  "--accent-line",
  "--accent-weak",
  "--accent-weak-border",
  "--grad-from",
  "--grad-via",
  "--grad-to",
  "--accent-glow",
  "--accent-glow-strong",
  "--hero-glow",
  "--body-gradient",
  "--brand-tint"
] as const;

type AccentVars = Partial<Record<(typeof ACCENT_VAR_KEYS)[number], string>>;

/* ---------- colour maths ---------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let clean = hex.replace("#", "").trim();
  if (clean.length === 3) clean = clean.split("").map((c) => c + c).join("");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Relative luminance of an HSL colour, for picking readable on-accent text. */
function hslLuminance(h: number, s: number, l: number): number {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const lin = (v: number) => {
    const n = v + m;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function isHex(value: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

export function isDefaultAccent(value: AccentValue): boolean {
  return value === DEFAULT_ACCENT;
}

/** Resolve an accent value (preset key or hex) to a base hex string. */
export function accentToHex(value: AccentValue): string {
  if (isHex(value)) return value;
  const preset = ACCENT_PRESETS.find((entry) => entry.key === value);
  return preset ? preset.hex : ACCENT_PRESETS[0].hex;
}

/** Derive the full CSS variable override set for a base hex in one mode. */
function deriveAccentVars(hex: string, mode: ThemeMode): AccentVars {
  const { h, s: s0 } = hexToHsl(hex);
  const s = clamp(s0, 55, 92);
  const via = (h + 30) % 360;
  const to = (h + 62) % 360;
  const dark = mode === "dark";

  const accentL = dark ? 62 : 48;
  const gradL = dark ? 62 : 52;
  const onAccent = hslLuminance(h, s, accentL) > 0.55 ? "#141019" : "#ffffff";

  return {
    "--accent": `hsl(${h} ${s}% ${accentL}%)`,
    "--accent-hover": `hsl(${h} ${s}% ${dark ? 68 : 42}%)`,
    "--accent-text": `hsl(${h} ${Math.min(s + 4, 96)}% ${dark ? 78 : 45}%)`,
    "--on-accent": onAccent,
    "--accent-line": `hsla(${h} ${s}% ${accentL}% / ${dark ? 0.55 : 0.5})`,
    "--accent-weak": `hsla(${h} ${s}% ${accentL}% / ${dark ? 0.14 : 0.12})`,
    "--accent-weak-border": `hsla(${h} ${s}% ${accentL}% / ${dark ? 0.32 : 0.3})`,
    "--grad-from": `hsl(${h} ${s}% ${gradL}%)`,
    "--grad-via": `hsl(${via} ${s}% ${gradL}%)`,
    "--grad-to": `hsl(${to} ${s}% ${gradL}%)`,
    "--accent-glow": `0 10px 30px hsla(${h} ${s}% 55% / ${dark ? 0.3 : 0.2})`,
    "--accent-glow-strong": `0 16px 44px hsla(${via} ${s}% 55% / ${dark ? 0.44 : 0.28})`,
    "--hero-glow": `hsla(${via} ${s}% 60% / ${dark ? 0.2 : 0.14})`,
    "--body-gradient": `hsla(${h} ${s}% 55% / ${dark ? 0.07 : 0.05})`,
    "--brand-tint": dark ? `hsl(${h} 40% 14%)` : `hsl(${h} 60% 93%)`
  };
}

/** Precompute both-mode override maps for the bootstrap cache. Default = none. */
function computeVarMaps(value: AccentValue): { dark: AccentVars; light: AccentVars } {
  if (isDefaultAccent(value)) return { dark: {}, light: {} };
  const hex = accentToHex(value);
  return { dark: deriveAccentVars(hex, "dark"), light: deriveAccentVars(hex, "light") };
}

/* ---------- read / persist / apply ---------- */

function readMode(): ThemeMode {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-mode");
    if (attr === "light" || attr === "dark") return attr;
  }
  return "dark";
}

function readAccent(): AccentValue {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  try {
    return window.localStorage.getItem(ACCENT_STORAGE_KEY) || DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

function applyToDom(mode: ThemeMode, accent: AccentValue) {
  const root = document.documentElement;
  root.setAttribute("data-mode", mode);
  root.setAttribute("data-accent", isHex(accent) ? "custom" : accent);
  const vars = computeVarMaps(accent)[mode];
  // Clear any previous overrides, then apply the current set.
  for (const key of ACCENT_VAR_KEYS) root.style.removeProperty(key);
  for (const [key, val] of Object.entries(vars)) root.style.setProperty(key, val);
}

function persistMode(mode: ThemeMode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* storage unavailable */
  }
}

function persistAccent(value: AccentValue) {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, value);
    window.localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify(computeVarMaps(value)));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Inline script that runs before first paint (see layout.tsx) to set the mode
 * and any accent overrides from the localStorage cache, avoiding a flash of the
 * wrong theme. Only applies a precomputed variable map — no colour maths here.
 */
export const themeBootstrapScript = `(function(){try{var d=document.documentElement;var m=localStorage.getItem('${THEME_STORAGE_KEY}');if(m!=='light'&&m!=='dark'){m=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}d.setAttribute('data-mode',m);var a=localStorage.getItem('${ACCENT_STORAGE_KEY}');if(a){d.setAttribute('data-accent',a.charAt(0)==='#'?'custom':a);}var v=localStorage.getItem('${ACCENT_VARS_KEY}');if(v){var maps=JSON.parse(v);var o=maps&&maps[m];if(o){for(var k in o){d.style.setProperty(k,o[k]);}}}}catch(e){document.documentElement.setAttribute('data-mode','dark');}})();`;

/* ---------- hooks ---------- */

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>("dark");
  const [accent, setAccentState] = useState<AccentValue>(DEFAULT_ACCENT);

  useEffect(() => {
    setModeState(readMode());
    setAccentState(readAccent());
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    persistMode(next);
    applyToDom(next, readAccent());
  }, []);

  const setAccent = useCallback((value: AccentValue) => {
    setAccentState(value);
    persistAccent(value);
    applyToDom(readMode(), value);
  }, []);

  const toggle = useCallback(() => {
    setMode(readMode() === "dark" ? "light" : "dark");
  }, [setMode]);

  return { mode, accent, setMode, setAccent, toggle };
}

/** Backwards-compatible subset used by ThemeToggle and older callers. */
export function useThemeMode() {
  const { mode, setMode, toggle } = useTheme();
  return { mode, setMode, toggle };
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
