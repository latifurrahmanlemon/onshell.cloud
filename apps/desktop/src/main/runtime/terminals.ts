/**
 * Open terminals, and the three ways of getting one.
 *
 * A terminal is a stream of bytes with a way to write back, a way to resize, and
 * a way to end. Where those bytes come from — a process on this machine, an SSH
 * connection this machine opened, or a WebSocket to the gateway — is this file's
 * only real subject, and the renderer is told which it got rather than left to
 * assume.
 *
 * When a direct connection cannot be made, this does not quietly relay instead.
 * The whole promise of direct mode is that Onshell is not on the wire, and a
 * session that silently stopped being end-to-end would make that promise
 * worthless. The failure is reported with the reason, and choosing the relay is
 * something the person does.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { discoverShells, spawnPty, type AgentPty, type ResolvedShell } from "@onshell/agent";
import type {
  LocalShell,
  TerminalEvent,
  TerminalOpenResult,
  TerminalOpened,
  TerminalTarget
} from "../../shared/ipc.js";
import { DirectUnavailableError, openDirectSession } from "./ssh.js";
import { openRelaySession } from "./relay.js";
import { requireApi } from "./session.js";

interface OpenTerminal {
  id: string;
  mode: "local" | "direct" | "relay";
  title: string;
  sessionId?: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

const terminals = new Map<string, OpenTerminal>();
let shellCache: ResolvedShell[] | undefined;

/** Emits terminal output and lifecycle to whoever is showing the window. */
export type TerminalEmitter = (event: TerminalEvent) => void;

/**
 * The shells this machine can offer.
 *
 * Discovered once and cached: enumerating WSL distributions shells out to
 * `wsl.exe`, which is slow enough to notice if it ran every time a tab opened.
 */
export async function localShells(): Promise<LocalShell[]> {
  shellCache ??= await discoverShells();
  return shellCache.map((shell) => ({
    id: shell.token,
    label: shell.label,
    // Shown in the UI on purpose. A program that opens shells on your machine
    // should be willing to say exactly which binary it is about to run.
    command: shell.file,
    args: shell.args,
    isDefault: shell.default
  }));
}

async function resolveShell(shellId?: string) {
  shellCache ??= await discoverShells();
  if (shellCache.length === 0) return undefined;
  return (
    shellCache.find((shell) => shell.token === shellId) ??
    shellCache.find((shell) => shell.default) ??
    shellCache[0]
  );
}

/** Opens a shell on this machine. No network, no server, no credential. */
async function openLocal(
  target: Extract<TerminalTarget, { kind: "local" }>,
  emit: TerminalEmitter
): Promise<TerminalOpened> {
  const shell = await resolveShell(target.shellId);
  if (!shell) throw new Error("No usable shell was found on this machine.");

  const id = randomUUID();
  let pty: AgentPty;
  try {
    pty = await spawnPty(shell, { cols: 80, rows: 24, cwd: target.cwd ?? homedir() });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Could not start that shell.");
  }

  pty.onData((chunk: Buffer) => emit({ terminalId: id, type: "data", data: chunk.toString("utf8") }));
  pty.onExit((code?: number) => {
    terminals.delete(id);
    emit({ terminalId: id, type: "exit", code });
  });

  if (!pty.pty) {
    // The native module did not load, so this is the stdio fallback: commands
    // run, but there is no job control and no window size. Saying so beats
    // leaving the user to work out why `vim` looks broken.
    emit({
      terminalId: id,
      type: "status",
      message: "Running without a pseudo-terminal — interactive programs may render oddly."
    });
  }

  terminals.set(id, {
    id,
    mode: "local",
    title: shell.label,
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    close: () => pty.kill()
  });

  return { terminalId: id, mode: "local", title: shell.label };
}

/** The saved host, for a title and for the relay's own bookkeeping. */
async function describeHost(hostId: string) {
  const hosts = await requireApi().hosts();
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (!host) throw new Error("That host is no longer in your workspace.");
  return host;
}

/** Dials the host from this machine. Onshell is not on the wire. */
async function openDirect(
  target: Extract<TerminalTarget, { kind: "direct" }>,
  emit: TerminalEmitter
): Promise<TerminalOpened> {
  const id = randomUUID();
  const session = await openDirectSession({
    hostId: target.hostId,
    credentialId: target.credentialId,
    onData: (chunk) => emit({ terminalId: id, type: "data", data: chunk.toString("utf8") }),
    onExit: (code, reason) => {
      terminals.delete(id);
      emit({ terminalId: id, type: "exit", code, reason });
    }
  });

  terminals.set(id, {
    id,
    mode: "direct",
    title: session.title,
    sessionId: session.sessionId,
    write: (data) => session.write(data),
    resize: (cols, rows) => session.resize(cols, rows),
    close: () => session.close()
  });

  emit({
    terminalId: id,
    type: "status",
    message: `Connected directly to ${session.title} — this traffic does not pass through Onshell.`
  });

  return { terminalId: id, mode: "direct", title: session.title, sessionId: session.sessionId };
}

/** Through the gateway, exactly as the browser console does it. */
async function openRelay(
  target: Extract<TerminalTarget, { kind: "relay" }>,
  emit: TerminalEmitter
): Promise<TerminalOpened> {
  const host = await describeHost(target.hostId);
  const id = randomUUID();
  const session = await openRelaySession({
    hostId: target.hostId,
    credentialId: target.credentialId,
    shell: target.shell,
    title: host.name,
    onData: (chunk) => emit({ terminalId: id, type: "data", data: chunk }),
    onExit: (reason) => {
      terminals.delete(id);
      emit({ terminalId: id, type: "exit", reason });
    }
  });

  terminals.set(id, {
    id,
    mode: "relay",
    title: session.title,
    sessionId: session.sessionId,
    write: (data) => session.write(data),
    resize: (cols, rows) => session.resize(cols, rows),
    close: () => session.close()
  });

  return { terminalId: id, mode: "relay", title: session.title, sessionId: session.sessionId };
}

export async function openTerminal(target: TerminalTarget, emit: TerminalEmitter): Promise<TerminalOpenResult> {
  try {
    switch (target.kind) {
      case "local":
        return { ok: true, terminal: await openLocal(target, emit) };
      case "direct":
        return { ok: true, terminal: await openDirect(target, emit) };
      case "relay":
        return { ok: true, terminal: await openRelay(target, emit) };
      default: {
        // A target the renderer invented. Refusing beats guessing.
        const unknown = target as { kind?: unknown };
        return { ok: false, error: `Unknown terminal target: ${String(unknown.kind)}` };
      }
    }
  } catch (error) {
    // A direct connection that could not be made is reported *as* a direct
    // failure, with the offer to relay attached. It is never relayed here: the
    // whole promise of direct mode is that Onshell is not on the wire, and
    // silently substituting the relay would break that promise in the one place
    // nobody would look.
    if (error instanceof DirectUnavailableError) {
      return { ok: false, error: error.message, code: error.code, canRelay: true };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Could not open that terminal." };
  }
}

export function writeTerminal(terminalId: string, data: string) {
  terminals.get(terminalId)?.write(data);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number) {
  // Clamped because these come from the renderer's measurement of its own
  // viewport, and a zero or absurd size reaches a real ioctl.
  const safeCols = Math.min(1000, Math.max(2, Math.floor(cols)));
  const safeRows = Math.min(1000, Math.max(1, Math.floor(rows)));
  terminals.get(terminalId)?.resize(safeCols, safeRows);
}

export async function closeTerminal(terminalId: string) {
  const terminal = terminals.get(terminalId);
  if (!terminal) return;
  terminals.delete(terminalId);
  terminal.close();
}

/**
 * Ends every session. Called when the window closes and when the app quits, so
 * that quitting really does stop everything — the property that makes a tray
 * icon a promise rather than decoration.
 */
export function closeAllTerminals() {
  for (const terminal of terminals.values()) terminal.close();
  terminals.clear();
}
