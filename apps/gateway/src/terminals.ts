/**
 * Terminals that outlive the browser socket attached to them.
 *
 * Until this existed, a terminal *was* its WebSocket: `socket.on("close")` ended
 * the shell. That made every reason a socket can drop — a laptop lid, a wifi
 * hand-off, a phone leaving a lift, an nginx reload, a browser throttling a
 * background tab — indistinguishable from the user deciding they were finished,
 * and the console could only report "session closed" and offer to start again.
 * Whatever was running in that shell was gone, which is the expensive half.
 *
 * So the shell is kept here instead, keyed by session, and a socket merely
 * *attaches* to it. When the socket goes the shell stays, its output collects in
 * a backlog, and the next socket for that session is handed the same shell plus
 * everything it missed. A shell is only really ended when the session is closed
 * on purpose, when the far end exits, or when nothing has come back to claim it
 * for {@link detachGraceMs} — the last of which is what stops a browser that is
 * never coming back from leaving a process running forever.
 */
import type { WebSocket } from "ws";
import { updateGatewaySession } from "./registry.js";

/**
 * A terminal, whichever transport produced it. The local shell, an agent shell
 * and an SSH channel all satisfy this, which is what lets one message pump —
 * and one reattach story — serve all three.
 */
export interface TerminalStream {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: () => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  end(): void;
}

/**
 * How long a shell waits, with nothing attached, before it is ended.
 *
 * Long enough to cover the things that are not the user leaving: a suspended
 * laptop, a train tunnel, a switch from wifi to a phone's hotspot, a proxy being
 * reloaded under an open console. Short enough that a browser which really has
 * gone does not hold a login on someone's server all day.
 */
let detachGraceMs = 15 * 60_000;

export function setDetachGraceMs(value: number) {
  detachGraceMs = value;
}

/**
 * How much output to keep for a browser that is not currently attached.
 *
 * A build left running can emit megabytes while a tab is asleep, and none of it
 * is worth holding in memory. Past this the oldest output is dropped and the
 * reconnecting terminal is told so, in the same spirit as a scrollback limit —
 * the recent end is the useful end.
 */
const MAX_BACKLOG_BYTES = 256 * 1024;

interface LiveTerminal {
  stream: TerminalStream;
  /** The socket reading this terminal right now, or null while detached. */
  socket: WebSocket | null;
  /** Output produced while detached, replayed to whoever attaches next. */
  backlog: string[];
  backlogBytes: number;
  /** Set once output has been dropped from the front of the backlog. */
  truncated: boolean;
  /** The far end has gone; the entry survives only to deliver its last words. */
  exited: boolean;
  graceTimer?: NodeJS.Timeout;
  /** Ends the underlying transport — closeSshClient, closeLocalShell, … */
  dispose: () => void;
}

const terminals = new Map<string, LiveTerminal>();

function send(socket: WebSocket, payload: string) {
  if (socket.readyState === socket.OPEN) socket.send(payload);
}

function controlFrame(type: string, data?: string) {
  return JSON.stringify(data === undefined ? { type } : { type, data });
}

function remember(terminal: LiveTerminal, chunk: string) {
  terminal.backlog.push(chunk);
  terminal.backlogBytes += Buffer.byteLength(chunk, "utf8");
  while (terminal.backlogBytes > MAX_BACKLOG_BYTES && terminal.backlog.length > 1) {
    const dropped = terminal.backlog.shift() as string;
    terminal.backlogBytes -= Buffer.byteLength(dropped, "utf8");
    terminal.truncated = true;
  }
}

function clearGrace(terminal: LiveTerminal) {
  if (!terminal.graceTimer) return;
  clearTimeout(terminal.graceTimer);
  terminal.graceTimer = undefined;
}

/** True when this session already has a shell someone can be reattached to. */
export function hasLiveTerminal(sessionId: string) {
  return terminals.has(sessionId);
}

/**
 * Ends a session's terminal now, whatever state it is in.
 *
 * Called when the session is closed deliberately (the console's close button,
 * the API's `POST /sessions/:id/close`) and when the grace period runs out.
 * Deliberate closes must not be forgiving: the whole point of the grace period
 * is to survive an *accident*, and an accident is not what a close button is.
 */
export function endTerminal(sessionId: string, reason = "Session closed") {
  const terminal = terminals.get(sessionId);
  if (!terminal) return;

  terminals.delete(sessionId);
  clearGrace(terminal);
  if (terminal.socket) {
    send(terminal.socket, controlFrame("exit", reason));
    if (terminal.socket.readyState === terminal.socket.OPEN) terminal.socket.close(1000, reason.slice(0, 100));
  }
  if (!terminal.exited) terminal.stream.end();
  terminal.dispose();
}

/**
 * Takes ownership of a freshly opened shell.
 *
 * From here on the stream's output goes to whichever socket is attached, or into
 * the backlog when none is — the pump is set up once, at registration, rather
 * than per socket. Wiring it per socket is what would lose the output produced
 * in the gap between one socket closing and the next one arriving, which is
 * precisely the window this file exists to cover.
 */
export function registerTerminal(
  sessionId: string,
  stream: TerminalStream,
  dispose: () => void,
  socket: WebSocket
): LiveTerminal {
  // A stale entry for the same id would leave two shells pumping into one
  // socket. Should not happen — callers check first — but it is cheap to be sure.
  endTerminal(sessionId);

  const terminal: LiveTerminal = {
    stream,
    // Attached from the first byte. Registering detached and attaching a line
    // later would send a shell's opening prompt to the backlog instead of to the
    // socket that is already waiting for it.
    socket,
    backlog: [],
    backlogBytes: 0,
    truncated: false,
    exited: false,
    dispose
  };
  terminals.set(sessionId, terminal);

  stream.onData((chunk) => {
    if (terminal.socket) {
      send(terminal.socket, chunk);
      return;
    }
    remember(terminal, chunk);
  });

  stream.onExit(() => {
    terminal.exited = true;
    if (terminal.socket) {
      // The shell really ended — the user typed `exit`, or the far side hung up.
      // The console must not treat this as a dropped connection and reconnect
      // into a session that no longer has anything behind it.
      send(terminal.socket, controlFrame("exit", "The remote shell ended."));
      if (terminal.socket.readyState === terminal.socket.OPEN) terminal.socket.close(1000, "Shell closed");
      terminals.delete(sessionId);
      clearGrace(terminal);
      dispose();
      return;
    }

    // Nobody is watching. The entry deliberately stays: a browser on its way
    // back is owed the shell's last words and the reason it ended, and dropping
    // the entry here would show it a bare "session closed" instead.
  });

  return terminal;
}

export interface AttachResult {
  /** The shell that was already running — what the new socket writes into. */
  stream: TerminalStream;
  /** Output that was produced while nothing was attached, oldest first. */
  backlog: string[];
  /** Whether the backlog had to drop its oldest output to stay bounded. */
  truncated: boolean;
  /** The far end exited while detached; the socket gets the backlog, then closes. */
  exited: boolean;
}

/**
 * Points a socket at a session's terminal, replaying whatever it missed.
 *
 * Returns undefined when there is nothing to attach to, which is the caller's
 * signal to open a shell and {@link registerTerminal} it instead.
 */
export function attachSocket(sessionId: string, socket: WebSocket): AttachResult | undefined {
  const terminal = terminals.get(sessionId);
  if (!terminal) return undefined;

  clearGrace(terminal);

  // Two sockets on one session is not a shared terminal — it is two keyboards on
  // one shell. The newcomer wins, because it is the one the user is looking at.
  //
  // The loser is sent "exit", not a plain close: a console that read this as a
  // dropped connection would reconnect, take the terminal back, and the two
  // windows would trade it back and forth forever. "exit" is the frame that
  // means "stop; do not come back", which is exactly the instruction here.
  if (terminal.socket && terminal.socket !== socket) {
    const previous = terminal.socket;
    terminal.socket = null;
    send(previous, controlFrame("exit", "This terminal was opened in another window."));
    if (previous.readyState === previous.OPEN) previous.close(1000, "Taken over");
  }

  terminal.socket = socket;
  const backlog = terminal.backlog;
  const truncated = terminal.truncated;
  terminal.backlog = [];
  terminal.backlogBytes = 0;
  terminal.truncated = false;

  if (terminal.exited) {
    terminals.delete(sessionId);
    clearGrace(terminal);
    terminal.dispose();
  }

  return { stream: terminal.stream, backlog, truncated, exited: terminal.exited };
}

/**
 * Marks a session's terminal as unattended and starts its countdown.
 *
 * `socket` is checked against the one on record so a socket that was already
 * replaced by a newer one cannot, on its own late close event, detach the
 * terminal out from under its successor.
 */
export function detachSocket(sessionId: string, socket: WebSocket) {
  const terminal = terminals.get(sessionId);
  if (!terminal || terminal.socket !== socket) return;

  terminal.socket = null;

  // Nothing to wait for: the shell is already gone, and holding the entry would
  // only delay the session being marked closed.
  if (terminal.exited) {
    terminals.delete(sessionId);
    clearGrace(terminal);
    terminal.dispose();
    updateGatewaySession(sessionId, { status: "closed" });
    return;
  }

  clearGrace(terminal);
  terminal.graceTimer = setTimeout(() => {
    terminals.delete(sessionId);
    terminal.stream.end();
    terminal.dispose();
    updateGatewaySession(sessionId, { status: "closed" });
  }, detachGraceMs);
  // A pending grace timer must not be a reason for the process to stay up.
  terminal.graceTimer.unref?.();
}

/** Test seam: drops every terminal without waiting for a grace period. */
export function resetTerminals() {
  for (const sessionId of [...terminals.keys()]) endTerminal(sessionId);
}
