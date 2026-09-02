/**
 * One xterm.js instance, bound to one terminal in the main process.
 *
 * Output arrives as IPC events and is filtered by terminal id here rather than
 * with a channel per terminal: channels are global to the window, and a
 * per-terminal name would leak ids into the IPC surface for no gain.
 *
 * The pane stays mounted when its tab is hidden. Tearing an xterm down and
 * rebuilding it would lose the scrollback, and a shell whose history vanishes
 * when you glance at another tab is not a terminal anyone wants.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { bridge } from "./bridge.js";
import type { AppearanceSettings } from "../shared/ipc.js";
import { terminalClipboardAction } from "./terminal-clipboard.js";

interface Props {
  terminalId: string;
  appearance: AppearanceSettings;
  visible: boolean;
  position?: "primary" | "secondary";
}

/** Terminal colours, kept in step with the tokens in app.css. */
const THEMES: Record<AppearanceSettings["terminalTheme"], NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"]> = {
  onshell: { background: "#0c1017", foreground: "#edf2f7", cursor: "#58d68d", selectionBackground: "#1e3a5f", black: "#0c1017", red: "#ff6b78", green: "#58d68d", yellow: "#f0b95a", blue: "#5aa9e6", magenta: "#b980f0", cyan: "#4fd1c5", white: "#edf2f7", brightBlack: "#637083" },
  nord: { background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0", selectionBackground: "#4c566a", black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#8fbcbb", white: "#e5e9f0", brightBlack: "#616e88" },
  dracula: { background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a", black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#8be9fd", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2", brightBlack: "#6272a4" },
  solarized: { background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selectionBackground: "#073642", black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5", brightBlack: "#586e75" },
  paper: { background: "#fbfaf7", foreground: "#253044", cursor: "#1f7a55", selectionBackground: "#dbeafe", black: "#253044", red: "#b42318", green: "#157f3d", yellow: "#9a6700", blue: "#175cd3", magenta: "#9e4784", cyan: "#087f8c", white: "#f2f4f7", brightBlack: "#667085" }
};

export function TerminalPane({ terminalId, appearance, visible, position = "primary" }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>(null);
  const fitRef = useRef<FitAddon>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number }>();

  async function copySelection() {
    const selection = termRef.current?.getSelection();
    if (!selection) return;
    await bridge.clipboard.writeText(selection);
    setContextMenu(undefined);
    termRef.current?.focus();
  }

  async function pasteClipboard() {
    const text = await bridge.clipboard.readText();
    if (text) termRef.current?.paste(text);
    setContextMenu(undefined);
    termRef.current?.focus();
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      cursorBlink: true,
      // Enough to hold a long build log, bounded so a runaway process cannot
      // grow the renderer's heap without limit.
      scrollback: 10_000,
      allowProposedApi: true,
      theme: THEMES[appearance.terminalTheme]
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const action = terminalClipboardAction(event, isMac, term.hasSelection());

      if (action === "copy") {
        event.preventDefault();
        const selection = term.getSelection();
        if (selection) void bridge.clipboard.writeText(selection);
        return false;
      }
      if (action === "paste") {
        event.preventDefault();
        void bridge.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });

    const input = term.onData((data) => bridge.terminals.write(terminalId, data));

    const unsubscribe = bridge.terminals.onEvent((event) => {
      if (event.terminalId !== terminalId) return;
      if (event.type === "data") term.write(event.data);
      // Status and exit are written into the scrollback rather than shown as
      // chrome: they belong to the session's history, and they survive a scroll
      // back through it the way the rest of the output does.
      if (event.type === "status") term.writeln(`\r\n\x1b[33m${event.message}\x1b[0m`);
      if (event.type === "exit") {
        term.writeln(`\r\n\x1b[90m[session ended${event.code == null ? "" : ` — exit ${event.code}`}]\x1b[0m`);
      }
    });

    // The pty must be told the size the user is actually looking at, or every
    // full-screen program draws for an 80x24 window inside a wider one.
    const sync = () => {
      if (!hostRef.current?.isConnected || hostRef.current.clientWidth === 0) return;
      fit.fit();
      bridge.terminals.resize(terminalId, term.cols, term.rows);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    sync();
    term.focus();

    return () => {
      observer.disconnect();
      unsubscribe();
      input.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Appearance changes are applied by the effect below rather than by
    // rebuilding, so they are deliberately not dependencies here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = appearance.fontFamily;
    term.options.fontSize = appearance.fontSize;
    term.options.theme = THEMES[appearance.terminalTheme];
    fitRef.current?.fit();
    bridge.terminals.resize(terminalId, term.cols, term.rows);
  }, [appearance.fontFamily, appearance.fontSize, appearance.terminalTheme, terminalId]);

  // A hidden pane measures as zero-width, so refit and refocus on the way back.
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    if (!term) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      bridge.terminals.resize(terminalId, term.cols, term.rows);
      term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, terminalId, position]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  return (
    <div
      className={`terminal-pane terminal-pane--${position}`}
      hidden={!visible}
      ref={paneRef}
      onContextMenu={(event) => {
        event.preventDefault();
        const bounds = paneRef.current?.getBoundingClientRect();
        if (!bounds) return;
        setContextMenu({
          x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 154)),
          y: Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 86))
        });
      }}
    >
      <div className="terminal-pane__host" ref={hostRef} />
      {contextMenu && (
        <div
          className="terminal-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button disabled={!termRef.current?.hasSelection()} onClick={() => void copySelection()} role="menuitem" type="button">
            <span>Copy</span><kbd>{/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"}</kbd>
          </button>
          <button onClick={() => void pasteClipboard()} role="menuitem" type="button">
            <span>Paste</span><kbd>{/Mac/.test(navigator.platform) ? "⌘V" : "Ctrl+V"}</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
