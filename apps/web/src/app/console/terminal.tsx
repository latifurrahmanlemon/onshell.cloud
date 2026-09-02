"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { DEFAULT_TERMINAL_SETTINGS, themeById, type TerminalSettings } from "./terminal-settings";

/**
 * `reconnecting` is not a failure. The shell is still running on the gateway,
 * which holds it for a grace period after a socket drops, and this terminal is
 * on its way back to it — so the console must not offer to start a new session,
 * which is what it does for `closed` and `error`.
 */
export type TerminalStatus = "connecting" | "connected" | "reconnecting" | "closed" | "error";

/**
 * How often the terminal pings the gateway over an open socket.
 *
 * Under the 60s an idle nginx proxy allows, and under the mobile-network NAT
 * timeouts that are shorter still. This is the traffic that keeps a terminal
 * nobody is typing into from being reaped by something in the middle.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** Ceiling on the reconnect backoff — long outages still get a try every 10s. */
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * WebSocket close code 1008. The gateway uses it for one thing: this session id
 * is not one it has. Reconnecting cannot change that answer.
 */
const WS_POLICY_VIOLATION = 1008;

interface XtermTerminalProps {
  websocketUrl: string;
  /** Colour theme and font size for this terminal, as saved for its host. */
  settings?: TerminalSettings;
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

export default function XtermTerminal({
  websocketUrl,
  settings = DEFAULT_TERMINAL_SETTINGS,
  onStatusChange,
  injectedCommand
}: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;
  // Read at construction only. Later changes go through the effect below, so
  // restyling a terminal never tears down its connection.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const lastInjectedId = useRef<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      fontFamily: 'var(--font-mono), "SFMono-Regular", Consolas, monospace',
      fontSize: settingsRef.current.fontSize,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: themeById(settingsRef.current.themeId).colors,
      minimumContrastRatio: 4.5,
      rescaleOverlappingGlyphs: true,
      allowProposedApi: true
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;

    // The mono webfont can finish loading after xterm measures its cells. A
    // stale measurement is especially visible when a command wraps: the new
    // row is painted over the old one. Re-measure once the real font is ready.
    void document.fonts?.ready.then(() => {
      if (terminalRef.current !== terminal) return;
      terminal.clearTextureAtlas();
      try {
        fit.fit();
      } catch {
        // The tab may have been hidden while the font loaded.
      }
    });

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
    /** The component is going away; nothing may schedule another attempt. */
    let disposed = false;
    /** The session is over for a reason reconnecting could not fix. */
    let finished = false;
    /** Consecutive failed attempts, for the backoff below. Reset on connect. */
    let attempt = 0;
    /** So the "reconnecting" notice is written once per outage, not per attempt. */
    let announcedDrop = false;
    let retryTimer: number | undefined;
    let heartbeat: number | undefined;
    let socket: WebSocket | null = null;

    function sendResize() {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    }

    function stopHeartbeat() {
      if (heartbeat === undefined) return;
      window.clearInterval(heartbeat);
      heartbeat = undefined;
    }

    function notice(text: string) {
      terminal.write(`\r\n\x1b[90m${text}\x1b[0m\r\n`);
    }

    /**
     * Backs off, then tries again — for as long as this terminal is on screen.
     *
     * The tab still being open is the entire signal. The gateway holds the shell
     * for a grace period after a socket drops (see apps/gateway/src/terminals.ts),
     * so a user who is still sitting in front of the console gets the same shell
     * back, with whatever it printed while they were gone.
     */
    function scheduleRetry() {
      if (disposed || finished || retryTimer !== undefined) return;
      const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt);
      attempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, delay);
    }

    /**
     * Tries again immediately, for the moments that mean "the network is back":
     * the tab being shown again, or the browser reporting it is online. Waiting
     * out a ten-second backoff after the user has visibly come back is the kind
     * of delay that reads as broken.
     */
    function retryNow() {
      if (disposed || finished) return;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      attempt = 0;
      connect();
    }

    function connect() {
      if (disposed || finished) return;

      const ws = new WebSocket(websocketUrl);
      ws.binaryType = "arraybuffer";
      socket = ws;
      socketRef.current = ws;
      if (everConnected) update("reconnecting");

      ws.onopen = () => {
        everConnected = true;
        attempt = 0;
        announcedDrop = false;
        update("connected");
        sendResize();
        terminal.focus();

        // An application-level heartbeat, because a WebSocket ping is invisible
        // to page JavaScript: a tab that has been asleep has no other way to
        // learn whether the socket a proxy is still holding open actually
        // reaches the gateway. It also keeps traffic on the wire, which is what
        // stops an idle-connection reaper from closing it in the first place.
        stopHeartbeat();
        heartbeat = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, HEARTBEAT_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
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
                finished = true;
                terminal.write(`\r\n\x1b[91m${frame.data ?? "The session could not be started."}\x1b[0m\r\n`);
                update("error", failure);
                return;
              }
              // The shell itself ended — someone typed `exit`, or the far side
              // hung up. Distinct from the socket dropping, and the distinction
              // is the point: reconnecting to a session with nothing behind it
              // would loop forever.
              if (frame.type === "exit") {
                finished = true;
                if (frame.data) notice(frame.data);
                return;
              }
              if (frame.type === "pong") return;
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

      ws.onerror = () => {
        // Fires without a reason of its own, and fires again on every failed
        // retry. Only the very first one is worth reporting: after that, onclose
        // decides whether this is recoverable and says so.
        if (!everConnected) {
          update("error", failure ?? "Could not reach the Onshell gateway. Check that it is running.");
        }
      };

      ws.onclose = (event) => {
        stopHeartbeat();
        if (disposed || socket !== ws) return;

        // The gateway refused the session id outright: it never existed, or its
        // grace period ran out while this browser was away. Nothing to go back to.
        if (event.code === WS_POLICY_VIOLATION) {
          finished = true;
          const reason = event.reason || "This session is no longer open.";
          update("error", reason);
          notice(`[${reason}]`);
          return;
        }

        if (finished || failure) {
          update(failure ? "error" : "closed", failure);
          notice("[session closed]");
          return;
        }

        // Never got a byte out of it and the gateway said why — a host that
        // refused, a machine that is switched off. Retrying just repeats it.
        if (!everConnected) {
          const reason = event.reason || undefined;
          update("error", reason);
          notice("[session closed]");
          return;
        }

        // Everything else is the connection, not the session. Say so, and go
        // back for the shell the gateway is still holding.
        update("reconnecting");
        if (!announcedDrop) {
          notice("[connection lost — reconnecting…]");
          announcedDrop = true;
        }
        scheduleRetry();
      };
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") retryNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", retryNow);

    connect();

    const dataDisposable = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    });

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
      disposed = true;
      stopHeartbeat();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", retryNow);
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      // Detached before closing: a retry swaps the URL, and the outgoing
      // socket's close event would otherwise report the *new* tab as closed.
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.close();
      }
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
    };
  }, [websocketUrl]);

  // Apply appearance changes in place. The re-fit matters as much as the
  // repaint: a larger font means fewer columns, and the remote shell has to be
  // told, or its line wrapping is drawn against the old grid.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    terminal.options.fontSize = settings.fontSize;
    terminal.options.theme = themeById(settings.themeId).colors;
    try {
      fitRef.current?.fit();
    } catch {
      // container hidden (an inactive tab); the ResizeObserver re-fits on show
    }
  }, [settings.fontSize, settings.themeId]);

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

  // The host's own background carries the theme colour so the padding around
  // the canvas matches it — otherwise a light theme sits in a dark frame.
  return (
    <div className="xterm-host" data-status={status} style={{ background: themeById(settings.themeId).colors.background }}>
      <div className="xterm-container" ref={containerRef} />
    </div>
  );
}
