/**
 * Local transport — a shell and a file browser on the machine the gateway itself
 * runs on, with no SSH hop and no credential.
 *
 * This is what backs the built-in "This computer" host: a brand-new workspace
 * can open a terminal before it has registered a single server.
 *
 * A real pty is used when `node-pty` is installed (an optional dependency, since
 * it needs a native build). Without it we fall back to piping an interactive
 * shell over stdio, which runs commands fine but has no job control, no window
 * size, and a duller prompt. The fallback is deliberate: a missing native module
 * must not take the whole gateway down.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { createGatewaySession, updateGatewaySession, type GatewaySession } from "../registry.js";

export interface OpenLocalSessionInput {
  hostId: string;
  /** Where the file browser starts. Defaults to the account's home directory. */
  startPath?: string;
}

/** The subset of node-pty's IPty that this module uses. */
interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: () => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
}

/**
 * A shell, either pty-backed or piped, behind one interface so the WebSocket
 * handler does not care which it got.
 */
export interface LocalShell {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: () => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  end(): void;
  /** False when running without a pty, so the client can be told why it feels off. */
  pty: boolean;
  /** Why the pty was unavailable. Logged once per session, never sent to the browser. */
  ptyError?: string;
}

const shells = new Map<string, LocalShell>();

const PTY_MODULE = "node-pty";

/** Interactive login shell for this platform. */
function shellCommand(): { file: string; args: string[] } {
  if (platform() === "win32") {
    return { file: process.env.COMSPEC ?? "powershell.exe", args: [] };
  }
  // -i keeps the prompt and rc files even when stdin is a pipe.
  return { file: process.env.SHELL ?? "/bin/bash", args: ["-i"] };
}

function wrapPty(pty: PtyProcess): LocalShell {
  return {
    onData: (listener) => pty.onData(listener),
    onExit: (listener) => pty.onExit(listener),
    write: (data) => pty.write(data),
    resize: (columns, rows) => pty.resize(columns, rows),
    end: () => pty.kill(),
    pty: true
  };
}

function wrapChild(child: ChildProcessWithoutNullStreams): LocalShell {
  return {
    onData: (listener) => {
      child.stdout.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
    },
    onExit: (listener) => {
      child.on("close", listener);
    },
    write: (data) => {
      child.stdin.write(data);
    },
    // Without a pty there is no window to resize; xterm's SIGWINCH has nowhere
    // to go, so this is a no-op rather than an error.
    resize: () => undefined,
    end: () => {
      child.kill();
    },
    pty: false
  };
}

/**
 * Starts the shell for a local session.
 *
 * Resolved lazily on first WebSocket connect rather than at session-open time so
 * a session that is never connected to does not leave a stray process behind.
 */
export async function openLocalShell(sessionId: string, size?: { columns: number; rows: number }) {
  const existing = shells.get(sessionId);
  if (existing) return existing;

  const { file, args } = shellCommand();
  const columns = size?.columns ?? 80;
  const rows = size?.rows ?? 24;
  const cwd = homedir();
  let shell: LocalShell;

  try {
    // Optional dependency: resolved at runtime so the gateway still boots (and
    // still serves SSH) on a host where the native module did not build. The
    // specifier is held in a variable on purpose — a literal would make this a
    // compile-time dependency and fail the build wherever node-pty is absent.
    const nodePty = (await import(PTY_MODULE)) as unknown as {
      spawn: (
        file: string,
        args: string[],
        options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
      ) => PtyProcess;
    };
    // No `-i` here: a pty already makes the shell interactive, and passing it
    // again confuses some shells' startup-file handling.
    shell = wrapPty(
      nodePty.spawn(file, [], {
        name: "xterm-256color",
        cols: columns,
        rows,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" }
      })
    );
  } catch (error) {
    shell = wrapChild(
      spawn(file, args, {
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
        stdio: ["pipe", "pipe", "pipe"]
      }) as ChildProcessWithoutNullStreams
    );
    // Surfaced so a broken pty is diagnosable rather than silently degraded.
    // "posix_spawnp failed." almost always means node-pty's spawn-helper lost its
    // exec bit — see scripts/fix-node-pty-permissions.mjs.
    shell.ptyError = error instanceof Error ? error.message : String(error);
  }

  shells.set(sessionId, shell);
  shell.onExit(() => {
    shells.delete(sessionId);
    updateGatewaySession(sessionId, { status: "closed" });
  });

  return shell;
}

export function closeLocalShell(sessionId: string) {
  const shell = shells.get(sessionId);
  if (!shell) return;
  shell.end();
  shells.delete(sessionId);
}

export function openLocalSession(input: OpenLocalSessionInput): GatewaySession {
  const session = createGatewaySession({
    protocol: "ssh",
    hostId: input.hostId,
    websocketPath: "",
    metadata: { transport: "local", address: "127.0.0.1", startPath: input.startPath ?? homedir() }
  });

  // Nothing to connect to, so it is usable immediately.
  return updateGatewaySession(session.id, {
    status: "active",
    websocketPath: `/ws/ssh/${session.id}`
  }) as GatewaySession;
}

export function openLocalFileSession(input: OpenLocalSessionInput): GatewaySession {
  const session = createGatewaySession({
    protocol: "sftp",
    hostId: input.hostId,
    metadata: { transport: "local", address: "127.0.0.1", startPath: input.startPath ?? homedir() }
  });

  return updateGatewaySession(session.id, { status: "active" }) as GatewaySession;
}

/**
 * Resolves a browser-supplied path against the local filesystem.
 *
 * "." means the session's start directory, which is where the console begins.
 * Relative paths resolve under it; absolute paths are honoured, because the
 * whole point of a local shell is that the operator already has this machine's
 * shell — restricting the file browser to a subtree would be security theatre
 * while `cd /` sits one keystroke away in the terminal tab.
 */
function resolveLocalPath(startPath: string, requested: string) {
  if (!requested || requested === "." || requested === "./") return startPath;
  const normalized = normalize(requested);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(join(startPath, normalized));
}

export async function listLocalDirectory(startPath: string, requested = ".") {
  const target = resolveLocalPath(startPath, requested);
  const entries = await readdir(target, { withFileTypes: true });

  const rows = await Promise.all(
    entries.map(async (entry) => {
      const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      // A dangling symlink or a directory we cannot stat should not fail the
      // whole listing — report it with zeroes instead.
      try {
        const info = await stat(join(target, entry.name));
        return {
          name: entry.name,
          type: entry.isSymbolicLink() ? (info.isDirectory() ? "directory" : "file") : type,
          size: info.size,
          modifiedAt: Math.floor(info.mtimeMs / 1000)
        };
      } catch {
        return { name: entry.name, type, size: 0, modifiedAt: 0 };
      }
    })
  );

  return { path: target, entries: rows };
}
