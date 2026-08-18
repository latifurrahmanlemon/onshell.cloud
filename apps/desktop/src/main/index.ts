/**
 * Onshell Desktop — main process.
 *
 * Holds the window, the session, and every socket. The renderer is a sandboxed
 * page that asks this process for things over the named channels in
 * `shared/ipc.ts`; it has no network access of its own, no filesystem, and never
 * sees a token or a credential.
 *
 * The window loads a page built into the app bundle, never a remote URL. A
 * compromise of onshell.cloud must not become code execution on every installed
 * copy of this app, and the only way to guarantee that is for the server never
 * to be a source of executable code.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, type AppState, type TerminalEvent, type TerminalTarget } from "../shared/ipc.js";
import { deriveServerConfig, loadSettings, saveSettings, LOCAL_DEV_SERVER } from "./runtime/settings.js";
import { keychainAvailable } from "./runtime/vault.js";
import {
  completeTwoFactor,
  currentServer,
  currentUser,
  probeServer,
  requireApi,
  resendTwoFactorCode,
  restoreSession,
  signIn,
  signOut,
  useServer
} from "./runtime/session.js";
import { forgetDevice } from "./runtime/device.js";
import {
  closeAllTerminals,
  closeTerminal,
  localShells,
  openTerminal,
  resizeTerminal,
  writeTerminal
} from "./runtime/terminals.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Set by the dev script; absent in a packaged app, which always loads from disk. */
const devServerUrl = process.env.ONSHELL_DEV_SERVER;

let window: BrowserWindow | null = null;

async function buildState(): Promise<AppState> {
  const settings = await loadSettings();
  const server = currentServer();
  return {
    version: app.getVersion(),
    platform: process.platform,
    server: server && { apiBaseUrl: server.apiBaseUrl, gatewayBaseUrl: server.gatewayBaseUrl, label: server.label },
    user: currentUser(),
    keychainAvailable: keychainAvailable(),
    connectionMode: settings.connectionMode,
    appearance: settings.appearance,
    sharing: settings.sharing
  };
}

/** Pushes state rather than letting the renderer poll, so the two cannot disagree. */
async function publishState() {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(CHANNELS.state, await buildState());
}

function emitTerminalEvent(event: TerminalEvent) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(CHANNELS.terminalEvent, event);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0f14",
    title: "Onshell",
    webPreferences: {
      preload: path.join(dir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The renderer has no business anywhere but its own page.
      webviewTag: false
    }
  });

  window.once("ready-to-show", () => window?.show());

  // A link in the UI opens in the user's real browser. Nothing gets to spawn a
  // second Electron window, which would have no address bar and no way for the
  // user to see where they had been taken.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });

  // Belt and braces for the same rule: any attempt to navigate the window away
  // from the bundled page is refused outright.
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    const isDevServer = devServerUrl && url.startsWith(devServerUrl);
    if (target.protocol !== "file:" && !isDevServer) {
      event.preventDefault();
      void openExternal(url);
    }
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(dir, "renderer", "index.html"));
  }

  window.on("closed", () => {
    window = null;
  });
}

/** Opens a URL in the user's browser. http(s) only — never a file or a scheme handler. */
async function openExternal(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    await shell.openExternal(parsed.href);
  } catch {
    // A malformed URL is not worth an error dialog; it just does not open.
  }
}

function registerHandlers() {
  ipcMain.handle(CHANNELS.getState, () => buildState());

  ipcMain.handle(CHANNELS.serverProbe, async (_event, input: string) => {
    try {
      const config = deriveServerConfig(input);
      const result = await probeServer(config);
      return result.ok ? { ok: true, server: config } : { ok: false, message: result.message };
    } catch {
      return { ok: false, message: "That does not look like a web address." };
    }
  });

  ipcMain.handle(CHANNELS.serverUse, async (_event, input: string) => {
    let config;
    try {
      config = deriveServerConfig(input);
    } catch {
      return { ok: false, message: "That does not look like a web address." };
    }

    const probe = await probeServer(config);
    if (!probe.ok) return { ok: false, message: probe.message };

    await saveSettings({ server: config });
    useServer(config);
    await restoreSession();
    await publishState();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.serverUseLocal, async () => {
    const probe = await probeServer(LOCAL_DEV_SERVER);
    if (!probe.ok) return { ok: false, message: probe.message };
    await saveSettings({ server: LOCAL_DEV_SERVER });
    useServer(LOCAL_DEV_SERVER);
    await restoreSession();
    await publishState();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.signIn, async (_event, request: { email: string; password: string; totpCode?: string }) => {
    const result = await signIn(request);
    await publishState();
    return result;
  });

  ipcMain.handle(CHANNELS.completeTwoFactor, async (_event, challengeId: string, code: string) => {
    const result = await completeTwoFactor(challengeId, code);
    await publishState();
    return result;
  });

  ipcMain.handle(CHANNELS.resendCode, (_event, challengeId: string) => resendTwoFactorCode(challengeId));

  ipcMain.handle(CHANNELS.signOut, async () => {
    // Sessions belong to the account that opened them, so signing out ends them
    // rather than leaving live shells behind an unauthenticated window.
    closeAllTerminals();
    await signOut();
    // The enrolment secret belongs to the account that created it, so the next
    // person to sign in on this computer enrols as their own device rather than
    // inheriting one that leases credentials under someone else's name.
    await forgetDevice();
    await publishState();
  });

  ipcMain.handle(CHANNELS.consoleLoad, async () => {
    const client = requireApi();
    // Fetched together because the console is unusable with a partial picture,
    // and six sequential round trips over a slow link is a visible stall.
    const [identity, hosts, credentials, snippets, sessions, audit] = await Promise.all([
      client.me(),
      client.hosts(),
      client.credentials(),
      client.snippets(),
      client.sessions(),
      client.audit(50)
    ]);
    return { identity, hosts, credentials, snippets, sessions, audit };
  });

  ipcMain.handle(CHANNELS.consoleHosts, () => requireApi().hosts());

  ipcMain.handle(CHANNELS.localShells, () => localShells());

  ipcMain.handle(CHANNELS.terminalOpen, (_event, target: TerminalTarget) =>
    openTerminal(target, emitTerminalEvent)
  );

  ipcMain.on(CHANNELS.terminalWrite, (_event, terminalId: string, data: string) => {
    if (typeof terminalId === "string" && typeof data === "string") writeTerminal(terminalId, data);
  });

  ipcMain.on(CHANNELS.terminalResize, (_event, terminalId: string, cols: number, rows: number) => {
    if (typeof terminalId === "string" && Number.isFinite(cols) && Number.isFinite(rows)) {
      resizeTerminal(terminalId, cols, rows);
    }
  });

  ipcMain.handle(CHANNELS.terminalClose, (_event, terminalId: string) => closeTerminal(terminalId));

  ipcMain.handle(CHANNELS.settingsUpdate, async (_event, patch) => {
    await saveSettings(patch);
    const state = await buildState();
    await publishState();
    return state;
  });

  ipcMain.handle(CHANNELS.openExternal, (_event, url: string) => openExternal(url));
}

// One window, one set of sessions. A second instance would race the first for
// the same token file and the same tray slot, so it hands over and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) return createWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(async () => {
    registerHandlers();

    const settings = await loadSettings();
    if (settings.server) {
      useServer(settings.server);
      // Not awaited before the window opens: a slow or unreachable server would
      // otherwise mean a blank screen for its whole timeout. The UI renders
      // signed-out and corrects itself when this resolves.
      void restoreSession().then(publishState);
    }

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // Terminals are the app's whole purpose, and leaving them running with no
    // window is exactly the invisible-remote-access shape this project avoids.
    closeAllTerminals();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", closeAllTerminals);
}
