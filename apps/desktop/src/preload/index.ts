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
    signOut: () => ipcRenderer.invoke(CHANNELS.signOut)
  },

  console: {
    load: () => ipcRenderer.invoke(CHANNELS.consoleLoad),
    hosts: () => ipcRenderer.invoke(CHANNELS.consoleHosts)
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

  settings: {
    update: (patch) => ipcRenderer.invoke(CHANNELS.settingsUpdate, patch)
  },

  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url)
};

contextBridge.exposeInMainWorld("onshell", bridge);
