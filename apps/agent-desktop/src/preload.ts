/**
 * The only bridge between the pairing window and the agent core.
 *
 * Context isolation is on and node integration is off, so the renderer is a
 * plain sandboxed web page. It can pair and read state — nothing else — and
 * only through these named channels, which the main process validates.
 */
import { contextBridge, ipcRenderer } from "electron";

type UiState = {
  version: string;
  paired: boolean;
  ownerEmail: string | null;
  running: boolean;
  approval: "trusted" | "ask" | "always";
  logPath: string;
};

type PairResult =
  | { ok: true; name: string; ownerEmail: string | null }
  | { ok: false; message: string };

contextBridge.exposeInMainWorld("onshell", {
  getState: (): Promise<UiState> => ipcRenderer.invoke("get-state"),
  pair: (code: string, name: string): Promise<PairResult> => ipcRenderer.invoke("pair", code, name),
  onState: (handler: (state: UiState) => void) => {
    const listener = (_event: unknown, state: UiState) => handler(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  }
});
