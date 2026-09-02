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
import { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, shell } from "electron";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, type AppState, type TerminalEvent, type TerminalTarget } from "../shared/ipc.js";
import { deriveServerConfig, loadSettings, saveSettings, LOCAL_DEV_SERVER } from "./runtime/settings.js";
import { keychainAvailable } from "./runtime/vault.js";
import {
  awaitBrowserSignIn,
  cancelBrowserSignIn,
  completeTwoFactor,
  currentServer,
  currentUser,
  probeServer,
  requireApi,
  resendTwoFactorCode,
  restoreSession,
  signIn,
  signOut,
  startBrowserSignIn,
  useServer
} from "./runtime/session.js";
import { forgetDevice } from "./runtime/device.js";
import { files, openFileSession, type FileSessionTarget } from "./runtime/files.js";
import {
  restoreSharing,
  setApproval,
  sharingState,
  shutdownSharing,
  startSharing,
  startSharingThisComputer,
  stopSharing
} from "./runtime/sharing.js";
import { checkForUpdate } from "./runtime/updates.js";
import type { ApprovalMode, DesktopDeviceSummary } from "../shared/ipc.js";
import {
  closeAllTerminals,
  closeTerminal,
  localShells,
  openTerminal,
  resizeTerminal,
  writeTerminal
} from "./runtime/terminals.js";
import { safeWorkspaceTargets } from "./runtime/workspace.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Set by the dev script; absent in a packaged app, which always loads from disk. */
const devServerUrl = process.env.ONSHELL_DEV_SERVER;

let window: BrowserWindow | null = null;
let tray: Tray | null = null;

async function buildState(): Promise<AppState> {
  const settings = await loadSettings();
  const server = currentServer();
  return {
    version: app.getVersion(),
    platform: process.platform,
    server: server && {
      apiBaseUrl: server.apiBaseUrl,
      gatewayBaseUrl: server.gatewayBaseUrl,
      label: server.label
    },
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

/** The tray image, copied next to the bundle at build time by copy-assets.mjs. */
function trayIcon() {
  const image = nativeImage.createFromPath(path.join(dir, "tray.png"));
  image.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(path.join(dir, "tray@2x.png")).toPNG()
  });
  // Not a template image: this is the real logo, and macOS renders a template as
  // a flat silhouette — which of a shield on a tile is just a rounded square.
  image.setTemplateImage(false);
  return image;
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
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 14 }
        }
      : {}),
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
    // Nothing is left waiting for a browser that has nowhere to report back to.
    // A poll loop outliving its window is an invisible request to the server
    // every couple of seconds, which is exactly the kind of thing that gets
    // noticed as a bug months later.
    cancelBrowserSignIn();
  });
}

/**
 * The tray, which exists for one reason: while this machine is being shared, a
 * program on it is answering requests to open shells. Software that does that
 * invisibly is spyware, and the difference is an icon the person can see and a
 * menu that stops it. When sharing is off the tray is still there, saying so.
 */
async function refreshTray() {
  if (!tray) return;
  const sharing = await sharingState();

  tray.setToolTip(
    sharing.running
      ? `Onshell — sharing this computer${sharing.ownerEmail ? ` with ${sharing.ownerEmail}` : ""}`
      : "Onshell — not sharing this computer"
  );

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: sharing.running ? "Sharing this computer" : "Not sharing this computer",
        enabled: false
      },
      { type: "separator" },
      sharing.running
        ? {
            label: "Stop sharing",
            click: () => void stopSharing().then(refreshTray)
          }
        : {
            label: sharing.paired ? "Start sharing" : "Share this computer…",
            click: () => {
              // Unpaired needs the signed-in session to mint a pairing code, so
              // it is done from the window rather than silently from a menu.
              if (sharing.paired) void startSharing().then(refreshTray);
              else showWindow();
            }
          },
      {
        label: "Open activity log",
        enabled: sharing.paired,
        click: () => void shell.openPath(sharing.logPath)
      },
      { type: "separator" },
      { label: "Open Onshell", click: showWindow },
      { label: "Quit — ends every session", click: () => app.quit() }
    ])
  );
}

function showWindow() {
  if (!window) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
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
  ipcMain.handle(CHANNELS.clipboardReadText, () => clipboard.readText());
  ipcMain.handle(CHANNELS.clipboardWriteText, (_event, text: unknown) => {
    if (typeof text !== "string") return;
    clipboard.writeText(text.slice(0, 1_000_000));
  });

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

  /**
   * Sign in from the browser.
   *
   * The renderer supplies nothing: the machine name, the platform, and the
   * version come from this process, and the URL is opened through the same
   * `openExternal` guard every other link uses rather than being handed to the
   * window to navigate to. A renderer that could choose either would be a
   * renderer that could send the user to a page of its choosing while the app
   * displayed a genuine-looking code.
   */
  ipcMain.handle(CHANNELS.browserSignInStart, async () => {
    const started = await startBrowserSignIn({
      machineName: hostname(),
      platform: process.platform,
      appVersion: app.getVersion()
    });
    if (started.ok) await openExternal(started.verificationUrl);
    return started;
  });

  ipcMain.handle(CHANNELS.browserSignInAwait, async () => {
    const outcome = await awaitBrowserSignIn();
    // Only an approval changes anything, but the push is unconditional: it is
    // what takes the window off the sign-in screen, and a state that disagreed
    // with the session would be worse than a redundant message.
    await publishState();
    return outcome;
  });

  ipcMain.handle(CHANNELS.browserSignInCancel, () => cancelBrowserSignIn());

  ipcMain.handle(CHANNELS.signOut, async () => {
    // Sessions belong to the account that opened them, so signing out ends them
    // rather than leaving live shells behind an unauthenticated window.
    closeAllTerminals();
    files.closeAll();
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
    const [identity, hosts, credentials, snippets, tasks, notifications, sessions, audit] = await Promise.all([
      client.me(),
      client.hosts(),
      client.credentials(),
      client.snippets(),
      client.tasks(),
      client.notifications(),
      client.sessions(),
      client.audit(50)
    ]);
    return { identity, hosts, credentials, snippets, tasks, notifications, sessions, audit };
  });

  ipcMain.handle(CHANNELS.consoleHosts, () => requireApi().hosts());
  ipcMain.handle(CHANNELS.consoleCreateHost, (_event, input: Record<string, unknown>) => requireApi().createHost(input));
  ipcMain.handle(CHANNELS.consoleUpdateHost, (_event, hostId: string, input: Record<string, unknown>) =>
    requireApi().updateHost(hostId, input)
  );
  ipcMain.handle(CHANNELS.consoleDeleteHost, async (_event, hostId: string) => {
    await requireApi().deleteHost(hostId);
  });
  ipcMain.handle(CHANNELS.consoleSnippets, () => requireApi().snippets());
  ipcMain.handle(CHANNELS.consoleCreateSnippet, async (_event, input: unknown) => {
    const body = input as { name?: unknown; command?: unknown; scope?: unknown };
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const command = typeof body?.command === "string" ? body.command : "";
    const scope = body?.scope === "team" ? "team" : "personal";
    if (name.length < 2 || command.length < 1) throw new Error("Name and command are required.");
    return requireApi().createSnippet({ name, command, scope });
  });
  ipcMain.handle(CHANNELS.consoleTasks, () => requireApi().tasks());
  ipcMain.handle(CHANNELS.consoleCreateTask, (_event, text: string) => requireApi().createTask(text));
  ipcMain.handle(CHANNELS.consoleUpdateTask, (_event, taskId: string, patch: { text?: string; completed?: boolean }) => requireApi().updateTask(taskId, patch));
  ipcMain.handle(CHANNELS.consoleDeleteTask, async (_event, taskId: string) => { await requireApi().deleteTask(taskId); });
  ipcMain.handle(CHANNELS.consoleNotifications, () => requireApi().notifications());
  ipcMain.handle(CHANNELS.consoleReadNotification, async (_event, notificationId: string) => { await requireApi().markNotificationRead(notificationId); });
  ipcMain.handle(CHANNELS.consoleCreateCredential, (_event, input: { name: string; kind: "password" | "ssh_key" | "rdp_password"; secret: string; attachedHostIds: string[] }) => requireApi().createCredential(input));
  ipcMain.handle(CHANNELS.consoleUpdateCredential, (_event, credentialId: string, input: { name?: string; attachedHostIds?: string[] }) => requireApi().updateCredential(credentialId, input));
  ipcMain.handle(CHANNELS.consoleRotateCredential, (_event, credentialId: string, secret: string) => requireApi().rotateCredential(credentialId, secret));
  ipcMain.handle(CHANNELS.consoleDeleteCredential, async (_event, credentialId: string) => { await requireApi().deleteCredential(credentialId); });
  ipcMain.handle(CHANNELS.consoleWorkspaces, () => requireApi().workspaces());
  ipcMain.handle(CHANNELS.consoleCreateWorkspace, (_event, input: { name: string; description?: string; hostIds: string[] }) => requireApi().createWorkspace(input));
  ipcMain.handle(CHANNELS.consoleDeleteWorkspace, async (_event, workspaceId: string) => { await requireApi().deleteWorkspace(workspaceId); });
  ipcMain.handle(CHANNELS.consoleSetFavorite, async (_event, hostId: string, favorite: boolean) => {
    await requireApi().setHostFavorite(hostId, favorite);
  });

  ipcMain.handle(CHANNELS.workspaceLoad, async () => {
    const owner = currentUser();
    const saved = (await loadSettings()).workspace;
    if (!owner || !saved || saved.ownerId !== owner.id) return { targets: [] };
    return {
      targets: safeWorkspaceTargets(saved.targets),
      updatedAt: saved.updatedAt
    };
  });

  ipcMain.handle(CHANNELS.workspaceSave, async (_event, input: unknown) => {
    const owner = currentUser();
    if (!owner) return { targets: [] };
    const targets = safeWorkspaceTargets(input);
    const updatedAt = new Date().toISOString();
    await saveSettings({
      workspace: { ownerId: owner.id, targets, updatedAt }
    });
    return { targets, updatedAt };
  });

  ipcMain.handle(CHANNELS.sharingState, () => sharingState());
  ipcMain.handle(CHANNELS.sharingStart, async (_event, name?: string) => {
    const state = await startSharingThisComputer(name);
    await refreshTray();
    return state;
  });
  ipcMain.handle(CHANNELS.sharingResume, async () => {
    const state = await startSharing();
    await refreshTray();
    return state;
  });
  ipcMain.handle(CHANNELS.sharingStop, async () => {
    const state = await stopSharing();
    await refreshTray();
    return state;
  });
  ipcMain.handle(CHANNELS.sharingApproval, async (_event, mode: ApprovalMode) => {
    const state = await setApproval(mode);
    await refreshTray();
    return state;
  });
  ipcMain.handle(CHANNELS.sharingOpenLog, async () => {
    await shell.openPath((await sharingState()).logPath);
  });

  ipcMain.handle(CHANNELS.devicesList, async () => {
    const payload = await requireApi().transport.request<{
      devices: DesktopDeviceSummary[];
    }>("/desktop/devices");
    return payload.devices;
  });

  ipcMain.handle(CHANNELS.devicesRevoke, async (_event, deviceId: string) => {
    await requireApi().transport.request(`/desktop/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST"
    });
  });

  ipcMain.handle(CHANNELS.filesOpen, (_event, target: FileSessionTarget) => openFileSession(target));
  ipcMain.handle(CHANNELS.filesList, (_event, id: string, target: string) => files.list(id, target));
  ipcMain.handle(CHANNELS.filesRead, (_event, id: string, target: string) => files.read(id, target));
  ipcMain.handle(CHANNELS.filesWrite, (_event, id: string, target: string, content: string) =>
    files.write(id, target, content)
  );
  ipcMain.handle(CHANNELS.filesMkdir, (_event, id: string, target: string) => files.mkdir(id, target));
  ipcMain.handle(CHANNELS.filesMove, (_event, id: string, from: string, to: string) => files.move(id, from, to));
  ipcMain.handle(CHANNELS.filesRemove, (_event, id: string, target: string, recursive: boolean) =>
    files.remove(id, target, recursive)
  );
  ipcMain.handle(CHANNELS.filesTransfer, (_event, fromId: string, fromPath: string, toId: string, toPath: string) =>
    files.transfer(fromId, fromPath, toId, toPath)
  );
  ipcMain.handle(CHANNELS.filesClose, (_event, id: string) => files.close(id));

  ipcMain.handle(CHANNELS.localShells, () => localShells());

  ipcMain.handle(CHANNELS.terminalOpen, (_event, target: TerminalTarget) => openTerminal(target, emitTerminalEvent));

  ipcMain.on(CHANNELS.terminalWrite, (_event, terminalId: string, data: string) => {
    if (typeof terminalId === "string" && typeof data === "string") writeTerminal(terminalId, data);
  });

  ipcMain.on(CHANNELS.terminalResize, (_event, terminalId: string, cols: number, rows: number) => {
    if (typeof terminalId === "string" && Number.isFinite(cols) && Number.isFinite(rows)) {
      resizeTerminal(terminalId, cols, rows);
    }
  });

  ipcMain.handle(CHANNELS.terminalClose, (_event, terminalId: string) => closeTerminal(terminalId));

  ipcMain.handle(CHANNELS.updatesCheck, (_event, force?: boolean) => checkForUpdate(force));

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

    tray = new Tray(trayIcon());
    await refreshTray();
    // Only if the user had it on. A tunnel that came up on its own because a
    // config file existed would be exactly the invisible remote access the tray
    // is there to prevent.
    void restoreSharing().then(refreshTray);

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // Terminals are the app's whole purpose, and leaving them running with no
    // window is exactly the invisible-remote-access shape this project avoids.
    closeAllTerminals();
    files.closeAll();
    // Sharing deliberately survives the window: someone who switched it on wants
    // their machine reachable, and the tray keeps saying so. Quitting stops it.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    closeAllTerminals();
    files.closeAll();
    cancelBrowserSignIn();
    shutdownSharing();
  });
}
