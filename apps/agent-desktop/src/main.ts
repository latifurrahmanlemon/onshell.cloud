/**
 * Onshell Agent — desktop shell.
 *
 * The command-line agent already does the real work: pair, hold a tunnel open,
 * serve terminals, write a local audit log. This process wraps that exact core
 * (`@onshell/agent`) in a menu-bar / tray presence and a one-window pairing
 * flow, so the person installing it double-clicks an installer and pastes a
 * code instead of opening a terminal. No agent logic is reimplemented here.
 *
 * The tray is not decoration. A remote-access program that runs invisibly is
 * spyware; the always-present tray icon, and the fact that quitting it stops
 * every session, are the visible-consent property the CLI provides by living in
 * a terminal window you can see.
 */
import { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AGENT_VERSION,
  APPROVAL_MODES,
  AgentTunnel,
  auditPath,
  discoverShells,
  loadAgentConfig,
  pair,
  saveAgentConfig,
  type AgentConfig,
  type ApprovalMode,
  type ResolvedShell
} from "@onshell/agent";

const dir = path.dirname(fileURLToPath(import.meta.url));

type UiState = {
  version: string;
  paired: boolean;
  ownerEmail: string | null;
  running: boolean;
  approval: ApprovalMode;
  logPath: string;
};

let tray: Tray | null = null;
let pairWindow: BrowserWindow | null = null;
let tunnel: AgentTunnel | null = null;
let config: AgentConfig | null = null;
let shells: ResolvedShell[] = [];

function isPaired(cfg: AgentConfig | null): cfg is AgentConfig {
  return !!cfg?.deviceToken && !!cfg.deviceId;
}

function uiState(): UiState {
  return {
    version: AGENT_VERSION,
    paired: isPaired(config),
    ownerEmail: config?.ownerEmail ?? null,
    running: tunnel !== null,
    approval: config?.approval ?? "ask",
    logPath: auditPath()
  };
}

/** Start serving, if this machine is paired. Safe to call when already running. */
async function startTunnel() {
  if (tunnel || !isPaired(config)) return;
  shells = await discoverShells();
  if (shells.length === 0) return; // Nothing to serve; tray still shows "paired, idle".
  tunnel = new AgentTunnel(config, shells);
  await tunnel.start();
  refresh();
}

function stopTunnel() {
  tunnel?.stop();
  tunnel = null;
  refresh();
}

async function reloadConfig() {
  config = await loadAgentConfig();
}

function trayIcon() {
  // From dist, not build/: electron-builder packs only dist, so the old
  // build/ path resolved to nothing inside the asar and the packaged app ran
  // with an empty tray icon. copy-renderer.mjs puts these here at build time.
  const image = nativeImage.createFromPath(path.join(dir, "tray.png"));
  image.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(path.join(dir, "tray@2x.png")).toPNG()
  });
  // Not a template image: this is the real logo, and macOS renders a template
  // as a flat silhouette — which of a shield on a tile is just a rounded square.
  image.setTemplateImage(false);
  return image;
}

function buildMenu(): Menu {
  const state = uiState();
  const approvalItems = APPROVAL_MODES.map((mode) => ({
    label:
      mode === "trusted"
        ? "Anyone in the workspace"
        : mode === "ask"
          ? "Only me — others ask (default)"
          : "Always ask, including me",
    type: "radio" as const,
    checked: state.approval === mode,
    click: () => void setApproval(mode)
  }));

  const template: Electron.MenuItemConstructorOptions[] = state.paired
    ? [
        { label: state.running ? "Connected" : "Paired — not connected", enabled: false },
        state.ownerEmail ? { label: state.ownerEmail, enabled: false } : { label: "", visible: false },
        { type: "separator" },
        state.running
          ? { label: "Disconnect", click: () => stopTunnel() }
          : { label: "Connect", click: () => void startTunnel() },
        { label: "Who may connect", submenu: approvalItems },
        { type: "separator" },
        { label: "Open activity log", click: () => void shell.openPath(state.logPath) },
        { label: `Onshell Agent ${state.version}`, enabled: false },
        { type: "separator" },
        { label: "Quit — stops all sessions", click: () => quit() }
      ]
    : [
        { label: "Not connected to an account", enabled: false },
        { type: "separator" },
        { label: "Connect this computer…", click: () => openPairWindow() },
        { label: `Onshell Agent ${state.version}`, enabled: false },
        { type: "separator" },
        { label: "Quit", click: () => quit() }
      ];

  return Menu.buildFromTemplate(template);
}

function refresh() {
  if (!tray) return;
  tray.setContextMenu(buildMenu());
  const state = uiState();
  tray.setToolTip(
    state.paired
      ? state.running
        ? `Onshell Agent — connected${state.ownerEmail ? ` (${state.ownerEmail})` : ""}`
        : "Onshell Agent — paired, not connected"
      : "Onshell Agent — not connected"
  );
  pairWindow?.webContents.send("state", state);
}

async function setApproval(mode: ApprovalMode) {
  await saveAgentConfig({ approval: mode });
  await reloadConfig();
  // Approval is read when a session opens, so a reconnect is the clean way to
  // apply it rather than reaching into the running tunnel's internals.
  if (tunnel) {
    stopTunnel();
    await startTunnel();
  }
  refresh();
}

function openPairWindow() {
  if (pairWindow) {
    pairWindow.focus();
    return;
  }
  pairWindow = new BrowserWindow({
    width: 420,
    height: 480,
    resizable: false,
    fullscreenable: false,
    title: "Connect this computer",
    webPreferences: {
      preload: path.join(dir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  pairWindow.on("closed", () => {
    pairWindow = null;
  });
  void pairWindow.loadFile(path.join(dir, "renderer", "index.html"));
}

function quit() {
  stopTunnel();
  app.quit();
}

// One code from the console pairs one machine; a second instance would fight the
// first over the same config file and tunnel. Keep a single instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (isPaired(config)) refresh();
    else openPairWindow();
  });

  app.whenReady().then(async () => {
    // A tray app has no business bouncing in the Dock.
    app.dock?.hide();

    await reloadConfig();
    tray = new Tray(trayIcon());
    refresh();

    if (isPaired(config)) {
      await startTunnel();
    } else {
      openPairWindow();
    }
  });

  // Closing the pairing window must not quit the tray app. The default action
  // for this event is to quit; a listener that does not call app.quit() keeps
  // the process alive in the menu bar, which is the whole point of a tray app.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => stopTunnel());
}

// Renderer → main. The renderer never touches the agent core directly; it asks
// through these two channels only.
ipcMain.handle("get-state", () => uiState());

ipcMain.handle("pair", async (_event, code: string, name: string) => {
  try {
    const result = await pair(code, name?.trim() || undefined);
    await reloadConfig();
    await startTunnel();
    refresh();
    return { ok: true as const, name: result.name, ownerEmail: result.ownerEmail ?? null };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
  }
});
