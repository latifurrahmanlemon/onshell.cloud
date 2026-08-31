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
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { bridge } from "./bridge.js";
import type { AppearanceSettings } from "../shared/ipc.js";

interface Props {
  terminalId: string;
  appearance: AppearanceSettings;
  visible: boolean;
  position?: "primary" | "secondary";
}

/** Terminal colours, kept in step with the tokens in app.css. */
const THEME = {
  background: "#0c1017",
  foreground: "#edf2f7",
  cursor: "#58d68d",
  selectionBackground: "#1e3a5f",
  black: "#0c1017",
  red: "#ff6b78",
  green: "#58d68d",
  yellow: "#f0b95a",
  blue: "#5aa9e6",
  magenta: "#b980f0",
  cyan: "#4fd1c5",
  white: "#edf2f7",
  brightBlack: "#637083"
} as const;

export function TerminalPane({ terminalId, appearance, visible, position = "primary" }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>(null);
  const fitRef = useRef<FitAddon>(null);

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
      theme: THEME
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

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
    fitRef.current?.fit();
    bridge.terminals.resize(terminalId, term.cols, term.rows);
  }, [appearance.fontFamily, appearance.fontSize, terminalId]);

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

  return <div className={`terminal-pane terminal-pane--${position}`} hidden={!visible} ref={hostRef} />;
}
