/**
 * Open terminals, and the three ways of getting one.
 *
 * A terminal is a stream of bytes with a way to write back, a way to resize, and
 * a way to end. Where those bytes come from — a process on this machine, an SSH
 * connection this machine opened, or a WebSocket to the gateway — is this file's
 * only real subject, and the renderer is told which it got rather than left to
 * assume.
 *
 * Local is implemented here. Direct and relay arrive with their phases; until
 * then they refuse clearly instead of silently falling back to something else,
 * because a terminal that quietly took a different route than the user chose is
 * the one behaviour this app must never have.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { discoverShells, spawnPty, type AgentPty, type ResolvedShell } from "@onshell/agent";
import type { LocalShell, TerminalEvent, TerminalOpened, TerminalTarget } from "../../shared/ipc.js";

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

export async function openTerminal(target: TerminalTarget, emit: TerminalEmitter): Promise<TerminalOpened> {
  switch (target.kind) {
    case "local":
      return openLocal(target, emit);
    case "direct":
      throw new Error("Direct connections are not available in this build yet.");
    case "relay":
      throw new Error("Relayed connections are not available in this build yet.");
    default: {
      // A target the renderer invented. Refusing beats guessing.
      const unknown = target as { kind?: unknown };
      throw new Error(`Unknown terminal target: ${String(unknown.kind)}`);
    }
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
