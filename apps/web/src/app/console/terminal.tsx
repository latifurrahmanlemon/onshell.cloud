"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type TerminalStatus = "connecting" | "connected" | "closed" | "error";

interface XtermTerminalProps {
  websocketUrl: string;
  /**
   * `detail` is the gateway's own words for a failure ("edge-01:22 refused the
   * connection…"), so the console can show why a host would not connect instead
   * of only that it did not.
   */
  onStatusChange?: (status: TerminalStatus, detail?: string) => void;
  /**
   * Incremented counter + command; when it changes the command is written to
   * the terminal. `execute` defaults to true (append a newline so it runs);
   * pass false to paste the text without running it.
   */
  injectedCommand?: { id: number; command: string; execute?: boolean } | null;
}

/**
 * Copy without the async clipboard API when it is unavailable: `navigator.clipboard`
 * is undefined on a non-secure origin, which is exactly how a self-hosted gateway
 * gets reached (http://10.x.x.x), and the terminal still has to be copyable there.
 */
function legacyCopy(text: string) {
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.top = "-1000px";
  helper.style.opacity = "0";
  // Selecting the helper takes focus off xterm's textarea, so hand it back or
  // the next keystroke goes nowhere.
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(helper);
  helper.select();
  try {
    document.execCommand("copy");
  } catch {
    // nothing left to try; the selection stays on screen for a manual copy
  }
  helper.remove();
  previous?.focus?.();
}

function copyToClipboard(text: string) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    return;
  }
  legacyCopy(text);
}

const terminalTheme = {
  background: "#08080f",
  foreground: "#d9ead6",
  cursor: "#34d399",
  cursorAccent: "#08080f",
  selectionBackground: "rgba(52, 211, 153, 0.3)",
  black: "#0a0b12",
  green: "#34d399",
  brightGreen: "#6ee7b7",
  cyan: "#22d3ee",
  red: "#fb7185",
  yellow: "#fbbf24"
};

export default function XtermTerminal({ websocketUrl, onStatusChange, injectedCommand }: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;
  const lastInjectedId = useRef<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      fontFamily: 'var(--font-mono), "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: terminalTheme,
      allowProposedApi: true
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminalRef.current = terminal;

    // Clipboard keys, the way a desktop terminal binds them. Left alone, xterm
    // turns Ctrl+C into SIGINT and Ctrl+V into a literal ^V, so neither reaches
    // the clipboard.
    //
    // Copy has to go through the clipboard API because an xterm selection is not
    // a DOM selection, so the browser has nothing of its own to copy. Paste is
    // the opposite: returning false leaves the browser's default intact, so the
    // native paste event still lands on xterm's textarea and xterm pastes it
    // itself — no clipboard-read permission, and it works over plain http too.
    const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const primary = isMac ? event.metaKey : event.ctrlKey;

      // Ctrl+Shift+C / Ctrl+Shift+V — the Linux terminal convention, and the
      // escape hatch when the shell needs a plain Ctrl+C.
      if (event.ctrlKey && event.shiftKey && !event.altKey && (key === "c" || key === "v")) {
        if (key === "c") {
          copyToClipboard(terminal.getSelection());
          event.preventDefault();
        }
        return false;
      }

      // A bare Ctrl+C with nothing selected must still interrupt the process.
      if (primary && !event.altKey && key === "c" && terminal.hasSelection()) {
        copyToClipboard(terminal.getSelection());
        terminal.clearSelection();
        event.preventDefault();
        return false;
      }

      if (primary && !event.altKey && key === "v") return false;

      // Ctrl+Insert / Shift+Insert, as bound on Windows terminals.
      if (event.key === "Insert") {
        if (event.ctrlKey && terminal.hasSelection()) {
          copyToClipboard(terminal.getSelection());
          event.preventDefault();
          return false;
        }
        if (event.shiftKey) return false;
      }

      return true;
    });

    const update = (next: TerminalStatus, detail?: string) => {
      setStatus(next);
      statusRef.current?.(next, detail);
    };

    // Held so the close that follows a failure frame reports the reason rather
    // than the generic "session closed" — the gateway sends the frame first,
    // then closes.
    let failure: string | undefined;
    let everConnected = false;

    const socket = new WebSocket(websocketUrl);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => {
      everConnected = true;
      update("connected");
      sendResize();
      terminal.focus();
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        // The gateway sends JSON control frames (e.g. {"type":"system","data":"..."}); everything else is raw output.
        if (event.data.startsWith('{"type":')) {
          try {
            const frame = JSON.parse(event.data) as { type?: string; data?: string };
            if (frame.type === "system") {
              terminal.write(`\x1b[90m${frame.data ?? ""}\x1b[0m\r\n`);
              return;
            }
            if (frame.type === "error") {
              failure = frame.data ?? undefined;
              terminal.write(`\r\n\x1b[91m${frame.data ?? "The session could not be started."}\x1b[0m\r\n`);
              update("error", failure);
              return;
            }
            if (frame.type === "data") {
              terminal.write(frame.data ?? "");
              return;
            }
          } catch {
            // fall through and print verbatim
          }
        }
        terminal.write(event.data);
      } else {
        terminal.write(new Uint8Array(event.data as ArrayBuffer));
      }
    };
    socket.onerror = () => {
      // Fires without a reason of its own — a socket that never opened at all
      // means the gateway itself is unreachable, which is worth saying.
      update(
        "error",
        failure ?? (everConnected ? undefined : "Could not reach the Onshell gateway. Check that it is running.")
      );
    };
    socket.onclose = (event) => {
      const reason = failure ?? (event.reason && !everConnected ? event.reason : undefined);
      update(reason ? "error" : "closed", reason);
      terminal.write(`\r\n\x1b[90m[session closed]\x1b[0m\r\n`);
    };

    const dataDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });

    function sendResize() {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    }

    const resizeDisposable = terminal.onResize(() => sendResize());
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // container hidden mid-transition; ignore
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      // Detached before closing: a retry swaps the URL, and the outgoing
      // socket's close event would otherwise report the *new* tab as closed.
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      socketRef.current = null;
    };
  }, [websocketUrl]);

  useEffect(() => {
    if (!injectedCommand || !injectedCommand.command) return;
    // Each injection has a unique id; process it once so re-passing the same
    // command (e.g. when this tab is re-focused) never re-runs it.
    if (lastInjectedId.current === injectedCommand.id) return;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      lastInjectedId.current = injectedCommand.id;
      const suffix = injectedCommand.execute === false ? "" : "\n";
      socket.send(`${injectedCommand.command}${suffix}`);
      terminalRef.current?.focus();
    }
  }, [injectedCommand]);

  return (
    <div className="xterm-host" data-status={status}>
      <div className="xterm-container" ref={containerRef} />
    </div>
  );
}
