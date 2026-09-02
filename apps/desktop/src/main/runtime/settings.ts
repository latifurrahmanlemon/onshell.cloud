/**
 * Desktop settings — everything that is not a secret.
 *
 * A plain JSON file in Electron's userData directory. Tokens deliberately do not
 * live here; they go through the OS keychain in `vault.ts`. Keeping the two
 * apart means this file can be read, edited, backed up, and pasted into a bug
 * report without leaking a session.
 *
 * The server URL is a setting rather than a constant because a self-hosted
 * Onshell has to work from the same signed installer as the hosted one. Nothing
 * in this binary is tied to onshell.cloud.
 */
import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TerminalTarget } from "../../shared/ipc.js";

export interface ServerConfig {
  /** API origin, no trailing slash — e.g. `https://onshell.cloud/api`. */
  apiBaseUrl: string;
  /** Gateway origin, used for relayed terminals and RDP. */
  gatewayBaseUrl: string;
  /** What to show the user; derived from the URL they typed. */
  label: string;
}

export interface DesktopSettings {
  server?: ServerConfig;
  /**
   * Stable per-install identifier, so re-enrolling after a reinstall updates
   * this machine's device row instead of adding another one. Not a secret and
   * not trusted for authentication — the enrolment secret in the keychain is
   * what the server actually checks.
   */
  deviceFingerprint?: string;
  /** Preferred connection path when a host supports more than one. */
  connectionMode: "direct" | "relay";
  appearance: {
    theme: "system" | "dark" | "light";
    fontFamily: string;
    fontSize: number;
    terminalTheme: "onshell" | "nord" | "dracula" | "solarized" | "paper";
    hostThemes: Record<string, "onshell" | "nord" | "dracula" | "solarized" | "paper">;
  };
  /** "Share this computer" — the agent tunnel. Off until switched on. */
  sharing: { enabled: boolean };
  /** Targets only. Bound to the account that saved them; never secrets or output. */
  workspace?: { ownerId: string; targets: TerminalTarget[]; updatedAt: string };
}

const DEFAULTS: DesktopSettings = {
  connectionMode: "direct",
  appearance: {
    theme: "system",
    // Deliberately a stack rather than one name: the first entry that exists on
    // the machine wins, and every platform has a different monospace default.
    fontFamily: "'Cascadia Mono', 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
    fontSize: 13,
    terminalTheme: "onshell",
    hostThemes: {}
  },
  sharing: { enabled: false }
};

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

let cache: DesktopSettings | null = null;

export async function loadSettings(): Promise<DesktopSettings> {
  if (cache) return cache;
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
    // Merged field by field rather than spread wholesale: a settings file written
    // by an older version is missing keys a newer one reads, and `undefined`
    // reaching the renderer as a font size is a blank terminal, not a default.
    cache = {
      server: parsed.server,
      deviceFingerprint: parsed.deviceFingerprint,
      connectionMode: parsed.connectionMode ?? DEFAULTS.connectionMode,
      appearance: { ...DEFAULTS.appearance, ...parsed.appearance },
      sharing: { ...DEFAULTS.sharing, ...parsed.sharing },
      workspace: parsed.workspace
    };
  } catch {
    // No file yet, or an unreadable one. Either way the app has to start.
    cache = { ...DEFAULTS };
  }
  return cache;
}

export async function saveSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
  const current = await loadSettings();
  const next: DesktopSettings = {
    ...current,
    ...patch,
    appearance: { ...current.appearance, ...patch.appearance },
    sharing: { ...current.sharing, ...patch.sharing }
  };
  cache = next;
  const file = settingsPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Turns whatever the user typed into a server configuration.
 *
 * People paste `onshell.cloud`, `https://onshell.cloud`, `https://onshell.cloud/`,
 * or the full API path. All four should work. The hosted layout puts the API at
 * `/api` and the gateway at `/gateway` behind one host, which is also what the
 * deployment guide tells self-hosters to do, so that is the assumption — and it
 * is verifiable, because the caller is expected to probe `/health` before
 * saving.
 */
export function deriveServerConfig(input: string): ServerConfig {
  const trimmed = input.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);

  // A URL that already ends in /api is the API itself — someone pasted the value
  // out of their own config rather than the address bar.
  const base = url.href.replace(/\/+$/, "");
  const isApiPath = /\/api$/i.test(url.pathname);
  const root = isApiPath ? base.slice(0, -"/api".length) : base;

  return {
    apiBaseUrl: `${root}/api`,
    gatewayBaseUrl: `${root}/gateway`,
    label: url.host
  };
}

/** Local development points at the two services directly, not through Nginx. */
export const LOCAL_DEV_SERVER: ServerConfig = {
  apiBaseUrl: "http://localhost:4000",
  gatewayBaseUrl: "http://localhost:4100",
  label: "localhost (development)"
};
