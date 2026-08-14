"use client";

/**
 * Per-terminal appearance: colour theme and font size, kept for each host and
 * remembered between visits.
 *
 * Keyed by host id rather than by tab, because a tab is a single connection —
 * its key changes on every reconnect — while "the way my database box looks"
 * is meant to outlive the session that set it.
 */

import { Copy, Minus, Plus, RotateCcw, X } from "lucide-react";
import { cx } from "@onshell/ui";

export interface TerminalTheme {
  id: string;
  label: string;
  /** Passed straight to xterm; only the keys we actually set are listed. */
  colors: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightGreen: string;
  };
}

export const TERMINAL_THEMES: TerminalTheme[] = [
  {
    id: "onshell",
    label: "Onshell",
    colors: {
      background: "#08080f",
      foreground: "#d9ead6",
      cursor: "#34d399",
      cursorAccent: "#08080f",
      selectionBackground: "rgba(52, 211, 153, 0.3)",
      black: "#0a0b12",
      red: "#fb7185",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#d9ead6",
      brightBlack: "#4b5563",
      brightGreen: "#6ee7b7"
    }
  },
  {
    id: "midnight",
    label: "Midnight",
    colors: {
      background: "#0b1220",
      foreground: "#dbe6f6",
      cursor: "#60a5fa",
      cursorAccent: "#0b1220",
      selectionBackground: "rgba(96, 165, 250, 0.32)",
      black: "#0b1220",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#facc15",
      blue: "#60a5fa",
      magenta: "#a78bfa",
      cyan: "#38bdf8",
      white: "#dbe6f6",
      brightBlack: "#475569",
      brightGreen: "#86efac"
    }
  },
  {
    id: "dracula",
    label: "Dracula",
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#ff79c6",
      cursorAccent: "#282a36",
      selectionBackground: "rgba(189, 147, 249, 0.35)",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightGreen: "#69ff94"
    }
  },
  {
    id: "nord",
    label: "Nord",
    colors: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#88c0d0",
      cursorAccent: "#2e3440",
      selectionBackground: "rgba(136, 192, 208, 0.32)",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightGreen: "#b9d09b"
    }
  },
  {
    id: "solarized-dark",
    label: "Solarized dark",
    colors: {
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "rgba(147, 161, 161, 0.3)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightGreen: "#9ead2c"
    }
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    colors: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#fe8019",
      cursorAccent: "#282828",
      selectionBackground: "rgba(254, 128, 25, 0.3)",
      black: "#282828",
      red: "#fb4934",
      green: "#b8bb26",
      yellow: "#fabd2f",
      blue: "#83a598",
      magenta: "#d3869b",
      cyan: "#8ec07c",
      white: "#ebdbb2",
      brightBlack: "#928374",
      brightGreen: "#d3d92f"
    }
  },
  {
    id: "solarized-light",
    label: "Solarized light",
    colors: {
      background: "#fdf6e3",
      foreground: "#586e75",
      cursor: "#657b83",
      cursorAccent: "#fdf6e3",
      selectionBackground: "rgba(88, 110, 117, 0.22)",
      black: "#073642",
      red: "#dc322f",
      green: "#657b0d",
      yellow: "#a37600",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#93a1a1",
      brightGreen: "#859900"
    }
  },
  {
    id: "paper",
    label: "Paper",
    colors: {
      background: "#ffffff",
      foreground: "#1f2933",
      cursor: "#0f766e",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(15, 118, 110, 0.2)",
      black: "#1f2933",
      red: "#b91c1c",
      green: "#15803d",
      yellow: "#a16207",
      blue: "#1d4ed8",
      magenta: "#a21caf",
      cyan: "#0e7490",
      white: "#e5e7eb",
      brightBlack: "#6b7280",
      brightGreen: "#16a34a"
    }
  }
];

export interface TerminalSettings {
  themeId: string;
  fontSize: number;
}

export const MIN_TERMINAL_FONT_SIZE = 9;
export const MAX_TERMINAL_FONT_SIZE = 24;

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = { themeId: "onshell", fontSize: 13 };

/** Every saved terminal preference on this device. */
export interface TerminalSettingsStore {
  /** Applied to a host that has never been customised. */
  fallback: TerminalSettings;
  byHost: Record<string, TerminalSettings>;
}

const STORAGE_KEY = "onshell-terminal-settings-v1";

export const EMPTY_TERMINAL_SETTINGS_STORE: TerminalSettingsStore = {
  fallback: DEFAULT_TERMINAL_SETTINGS,
  byHost: {}
};

export function themeById(themeId: string): TerminalTheme {
  return TERMINAL_THEMES.find((theme) => theme.id === themeId) ?? TERMINAL_THEMES[0];
}

/** Rejects anything the stored JSON should not contain — it is user-editable. */
function sanitize(value: unknown): TerminalSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TerminalSettings>;
  const fontSize = Number(raw.fontSize);
  return {
    themeId: themeById(typeof raw.themeId === "string" ? raw.themeId : "").id,
    fontSize: Number.isFinite(fontSize)
      ? Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)))
      : DEFAULT_TERMINAL_SETTINGS.fontSize
  };
}

export function loadTerminalSettings(): TerminalSettingsStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_TERMINAL_SETTINGS_STORE;

    const parsed = JSON.parse(raw) as Partial<TerminalSettingsStore>;
    const byHost: Record<string, TerminalSettings> = {};
    for (const [hostId, settings] of Object.entries(parsed.byHost ?? {})) {
      const clean = sanitize(settings);
      if (clean) byHost[hostId] = clean;
    }
    return { fallback: sanitize(parsed.fallback) ?? DEFAULT_TERMINAL_SETTINGS, byHost };
  } catch {
    // Storage blocked (private mode) or the entry is corrupt — defaults are fine.
    return EMPTY_TERMINAL_SETTINGS_STORE;
  }
}

export function saveTerminalSettings(store: TerminalSettingsStore) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable; the settings still apply for this visit */
  }
}

export function settingsForHost(store: TerminalSettingsStore, hostId: string): TerminalSettings {
  return store.byHost[hostId] ?? store.fallback;
}

interface TerminalSettingsPanelProps {
  hostName: string;
  settings: TerminalSettings;
  /** True when this host has no entry of its own and is showing the default. */
  usingFallback: boolean;
  onChange: (patch: Partial<TerminalSettings>) => void;
  onReset: () => void;
  /** Copies these settings to every other open terminal and to new ones. */
  onApplyToAll: () => void;
  onClose: () => void;
}

export function TerminalSettingsPanel({
  hostName,
  settings,
  usingFallback,
  onChange,
  onReset,
  onApplyToAll,
  onClose
}: TerminalSettingsPanelProps) {
  const setFontSize = (next: number) =>
    onChange({ fontSize: Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, next)) });

  return (
    <div className="terminal-settings-menu" role="dialog" aria-label={`Appearance for ${hostName}`}>
      <div className="terminal-settings-head">
        <div>
          <strong>Appearance</strong>
          <span>
            {hostName}
            {usingFallback && " · using default"}
          </span>
        </div>
        <button aria-label="Close appearance settings" className="icon-button compact" onClick={onClose} type="button">
          <X size={13} />
        </button>
      </div>

      <p className="terminal-settings-label">Colour theme</p>
      <div className="terminal-theme-grid">
        {TERMINAL_THEMES.map((theme) => (
          <button
            aria-pressed={settings.themeId === theme.id}
            className={cx("terminal-theme-swatch", settings.themeId === theme.id && "is-active")}
            key={theme.id}
            onClick={() => onChange({ themeId: theme.id })}
            type="button"
          >
            <span
              className="terminal-theme-preview"
              style={{ background: theme.colors.background, color: theme.colors.foreground }}
            >
              <em style={{ background: theme.colors.green }} />
              <em style={{ background: theme.colors.yellow }} />
              <em style={{ background: theme.colors.blue }} />
              <em style={{ background: theme.colors.red }} />
            </span>
            {theme.label}
          </button>
        ))}
      </div>

      <p className="terminal-settings-label">Font size</p>
      <div className="terminal-font-row">
        <button
          aria-label="Smaller font"
          className="icon-button compact"
          disabled={settings.fontSize <= MIN_TERMINAL_FONT_SIZE}
          onClick={() => setFontSize(settings.fontSize - 1)}
          type="button"
        >
          <Minus size={13} />
        </button>
        <input
          aria-label="Terminal font size"
          max={MAX_TERMINAL_FONT_SIZE}
          min={MIN_TERMINAL_FONT_SIZE}
          onChange={(event) => setFontSize(Number(event.target.value))}
          type="range"
          value={settings.fontSize}
        />
        <button
          aria-label="Larger font"
          className="icon-button compact"
          disabled={settings.fontSize >= MAX_TERMINAL_FONT_SIZE}
          onClick={() => setFontSize(settings.fontSize + 1)}
          type="button"
        >
          <Plus size={13} />
        </button>
        <span className="terminal-font-value">{settings.fontSize}px</span>
      </div>

      <div className="terminal-settings-actions">
        <button className="secondary-button" onClick={onApplyToAll} type="button">
          <Copy size={13} />
          Use everywhere
        </button>
        <button className="secondary-button" disabled={usingFallback} onClick={onReset} type="button">
          <RotateCcw size={13} />
          Reset
        </button>
      </div>
    </div>
  );
}
