/**
 * The bridge, and the entire attack surface the renderer has.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so the renderer is a
 * plain sandboxed web page with no `require`, no `process`, and no filesystem.
 * What it can do is exactly what is listed below, and each entry lands on a
 * named channel that the main process validates before acting.
 *
 * Keep this file short enough to read in one sitting. If it ever needs a
 * scrollbar, something has been added that should have been done in the main
 * process instead.
 */
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type OnshellBridge } from "../shared/ipc.js";

/** Wires an ipcRenderer event to a handler and returns the unsubscribe. */
function subscribe<T>(channel: string, handler: (payload: T) => void) {
  const listener = (_event: unknown, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: OnshellBridge = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  onState: (handler) => subscribe(CHANNELS.state, handler),

  server: {
    probe: (input) => ipcRenderer.invoke(CHANNELS.serverProbe, input),
    use: (input) => ipcRenderer.invoke(CHANNELS.serverUse, input),
    useLocalDevelopment: () => ipcRenderer.invoke(CHANNELS.serverUseLocal)
  },

  auth: {
    signIn: (request) => ipcRenderer.invoke(CHANNELS.signIn, request),
    completeTwoFactor: (challengeId, code) => ipcRenderer.invoke(CHANNELS.completeTwoFactor, challengeId, code),
    resendCode: (challengeId) => ipcRenderer.invoke(CHANNELS.resendCode, challengeId),
    signOut: () => ipcRenderer.invoke(CHANNELS.signOut),
    startBrowserSignIn: () => ipcRenderer.invoke(CHANNELS.browserSignInStart),
    awaitBrowserSignIn: () => ipcRenderer.invoke(CHANNELS.browserSignInAwait),
    cancelBrowserSignIn: () => ipcRenderer.invoke(CHANNELS.browserSignInCancel)
  },

  console: {
    load: () => ipcRenderer.invoke(CHANNELS.consoleLoad),
    hosts: () => ipcRenderer.invoke(CHANNELS.consoleHosts),
    createHost: (input) => ipcRenderer.invoke(CHANNELS.consoleCreateHost, input),
    updateHost: (hostId, input) => ipcRenderer.invoke(CHANNELS.consoleUpdateHost, hostId, input),
    deleteHost: (hostId) => ipcRenderer.invoke(CHANNELS.consoleDeleteHost, hostId),
    snippets: () => ipcRenderer.invoke(CHANNELS.consoleSnippets),
    createSnippet: (input) => ipcRenderer.invoke(CHANNELS.consoleCreateSnippet, input),
    tasks: () => ipcRenderer.invoke(CHANNELS.consoleTasks),
    createTask: (text) => ipcRenderer.invoke(CHANNELS.consoleCreateTask, text),
    updateTask: (taskId, patch) => ipcRenderer.invoke(CHANNELS.consoleUpdateTask, taskId, patch),
    deleteTask: (taskId) => ipcRenderer.invoke(CHANNELS.consoleDeleteTask, taskId),
    notifications: () => ipcRenderer.invoke(CHANNELS.consoleNotifications),
    markNotificationRead: (notificationId) => ipcRenderer.invoke(CHANNELS.consoleReadNotification, notificationId),
    createCredential: (input) => ipcRenderer.invoke(CHANNELS.consoleCreateCredential, input),
    updateCredential: (credentialId, input) => ipcRenderer.invoke(CHANNELS.consoleUpdateCredential, credentialId, input),
    rotateCredential: (credentialId, secret) => ipcRenderer.invoke(CHANNELS.consoleRotateCredential, credentialId, secret),
    deleteCredential: (credentialId) => ipcRenderer.invoke(CHANNELS.consoleDeleteCredential, credentialId),
    workspaces: () => ipcRenderer.invoke(CHANNELS.consoleWorkspaces),
    createWorkspace: (input) => ipcRenderer.invoke(CHANNELS.consoleCreateWorkspace, input),
    deleteWorkspace: (workspaceId) => ipcRenderer.invoke(CHANNELS.consoleDeleteWorkspace, workspaceId),
    setFavorite: (hostId, favorite) => ipcRenderer.invoke(CHANNELS.consoleSetFavorite, hostId, favorite)
  },

  devices: {
    list: () => ipcRenderer.invoke(CHANNELS.devicesList),
    revoke: (deviceId) => ipcRenderer.invoke(CHANNELS.devicesRevoke, deviceId)
  },

  sharing: {
    state: () => ipcRenderer.invoke(CHANNELS.sharingState),
    start: (name) => ipcRenderer.invoke(CHANNELS.sharingStart, name),
    resume: () => ipcRenderer.invoke(CHANNELS.sharingResume),
    stop: () => ipcRenderer.invoke(CHANNELS.sharingStop),
    setApproval: (mode) => ipcRenderer.invoke(CHANNELS.sharingApproval, mode),
    openLog: () => ipcRenderer.invoke(CHANNELS.sharingOpenLog)
  },

  files: {
    open: (target) => ipcRenderer.invoke(CHANNELS.filesOpen, target),
    list: (id, path) => ipcRenderer.invoke(CHANNELS.filesList, id, path),
    read: (id, path) => ipcRenderer.invoke(CHANNELS.filesRead, id, path),
    write: (id, path, content) => ipcRenderer.invoke(CHANNELS.filesWrite, id, path, content),
    mkdir: (id, path) => ipcRenderer.invoke(CHANNELS.filesMkdir, id, path),
    move: (id, from, to) => ipcRenderer.invoke(CHANNELS.filesMove, id, from, to),
    remove: (id, path, recursive) => ipcRenderer.invoke(CHANNELS.filesRemove, id, path, recursive),
    transfer: (fromId, fromPath, toId, toPath) =>
      ipcRenderer.invoke(CHANNELS.filesTransfer, fromId, fromPath, toId, toPath),
    close: (id) => ipcRenderer.invoke(CHANNELS.filesClose, id)
  },

  terminals: {
    localShells: () => ipcRenderer.invoke(CHANNELS.localShells),
    open: (target) => ipcRenderer.invoke(CHANNELS.terminalOpen, target),
    // Keystrokes are `send`, not `invoke`: a round trip per character would put
    // the IPC latency inside the typing loop, and there is no reply to wait for.
    write: (terminalId, data) => ipcRenderer.send(CHANNELS.terminalWrite, terminalId, data),
    resize: (terminalId, cols, rows) => ipcRenderer.send(CHANNELS.terminalResize, terminalId, cols, rows),
    close: (terminalId) => ipcRenderer.invoke(CHANNELS.terminalClose, terminalId),
    onEvent: (handler) => subscribe(CHANNELS.terminalEvent, handler)
  },

  workspace: {
    load: () => ipcRenderer.invoke(CHANNELS.workspaceLoad),
    save: (targets) => ipcRenderer.invoke(CHANNELS.workspaceSave, targets)
  },

  clipboard: {
    readText: () => ipcRenderer.invoke(CHANNELS.clipboardReadText),
    writeText: (text) => ipcRenderer.invoke(CHANNELS.clipboardWriteText, text)
  },

  updates: {
    check: (force) => ipcRenderer.invoke(CHANNELS.updatesCheck, force)
  },

  settings: {
    update: (patch) => ipcRenderer.invoke(CHANNELS.settingsUpdate, patch)
  },

  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url)
};

contextBridge.exposeInMainWorld("onshell", bridge);
