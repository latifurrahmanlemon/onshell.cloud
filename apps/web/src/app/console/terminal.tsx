"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type TerminalStatus = "connecting" | "connected" | "closed" | "error";

interface XtermTerminalProps {
  websocketUrl: string;
  onStatusChange?: (status: TerminalStatus) => void;
  /** Incremented counter + command; when it changes the command is written to the terminal. */
  injectedCommand?: { id: number; command: string } | null;
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

    const update = (next: TerminalStatus) => {
      setStatus(next);
      statusRef.current?.(next);
    };

    const socket = new WebSocket(websocketUrl);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => {
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
    socket.onerror = () => update("error");
    socket.onclose = () => {
      update("closed");
      terminal.write("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
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
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      socketRef.current = null;
    };
  }, [websocketUrl]);

  useEffect(() => {
    if (!injectedCommand || !injectedCommand.command) return;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(`${injectedCommand.command}\n`);
      terminalRef.current?.focus();
    }
  }, [injectedCommand]);

  return (
    <div className="xterm-host" data-status={status}>
      <div className="xterm-container" ref={containerRef} />
    </div>
  );
}
