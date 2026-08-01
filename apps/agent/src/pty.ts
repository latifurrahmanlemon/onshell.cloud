/**
 * Spawning a shell attached to a pseudo-terminal.
 *
 * `node-pty` is an optional dependency because it is a native module: on a
 * machine where the prebuild does not match, or the build toolchain is absent,
 * the agent must still start and still give the user a working shell. So a
 * failure to load it degrades to piping the shell over stdio — commands run,
 * but there is no job control, no window size, and a plainer prompt. The
 * console tells the user that has happened rather than leaving them to wonder
 * why `vim` looks broken.
 *
 * This mirrors the same tradeoff the gateway makes for its own local transport
 * in apps/gateway/src/protocols/local.ts.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ResolvedShell } from "./shells.js";

/** The subset of node-pty's IPty this module uses. */
interface NodePty {
  pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
}

export interface AgentPty {
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code?: number) => void): void;
  write(data: Buffer | string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  pid?: number;
  /** False when this is the stdio fallback rather than a real pty. */
  pty: boolean;
}

export interface SpawnPtyOptions {
  cols: number;
  rows: number;
  cwd: string;
}

const PTY_MODULE = "node-pty";

/** Set on the first spawn attempt; reported in `hello` so the console can explain itself. */
let ptyLoadError: string | undefined;
let ptyProbed = false;

export function ptyStatus() {
  return { available: ptyProbed && ptyLoadError === undefined, error: ptyLoadError };
}

function wrapNodePty(pty: NodePty): AgentPty {
  return {
    onData: (listener) => pty.onData((data) => listener(Buffer.from(data, "utf8"))),
    onExit: (listener) => pty.onExit((event) => listener(event.exitCode)),
    write: (data) => pty.write(typeof data === "string" ? data : data.toString("utf8")),
    resize: (columns, rows) => pty.resize(columns, rows),
    kill: () => pty.kill(),
    pid: pty.pid,
    pty: true
  };
}

function wrapChild(child: ChildProcessWithoutNullStreams): AgentPty {
  return {
    onData: (listener) => {
      child.stdout.on("data", (chunk: Buffer) => listener(chunk));
      child.stderr.on("data", (chunk: Buffer) => listener(chunk));
    },
    onExit: (listener) => {
      child.on("close", (code) => listener(code ?? undefined));
    },
    write: (data) => {
      child.stdin.write(data);
    },
    // No pty means no window, so SIGWINCH has nowhere to go. A no-op rather
    // than an error: resize is advisory, and failing it would kill sessions
    // that are otherwise perfectly usable.
    resize: () => undefined,
    kill: () => {
      child.kill();
    },
    pid: child.pid,
    pty: false
  };
}

export async function spawnPty(shell: ResolvedShell, options: SpawnPtyOptions): Promise<AgentPty> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    // Lets a shell profile or a script detect it is running under Onshell —
    // useful for prompts, and honest about the fact that it is remote.
    ONSHELL_AGENT: "1"
  };

  try {
    // Held in a variable on purpose: a literal specifier would make this a
    // compile-time dependency and break the build anywhere node-pty is absent.
    const nodePty = (await import(PTY_MODULE)) as unknown as {
      spawn: (
        file: string,
        args: string[],
        options: {
          name: string;
          cols: number;
          rows: number;
          cwd: string;
          env: NodeJS.ProcessEnv;
          useConptyDll?: boolean;
        }
      ) => NodePty;
    };

    ptyProbed = true;
    ptyLoadError = undefined;
    return wrapNodePty(
      nodePty.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env,
        // Use the bundled ConPTY rather than the one in the OS.
        //
        // Not a performance choice: the OS path tears a terminal down by
        // forking a helper that calls AttachConsole on the dying shell, then
        // races it by killing the pty immediately. The helper loses that race
        // and dies printing an unhandled `AttachConsole failed` stack to our
        // stderr on *every* terminal close. Harmless — the agent survives and
        // the next terminal works — but this program has to look trustworthy on
        // someone's personal machine, and a stack trace every time a tab closes
        // does not. The DLL path skips the helper entirely.
        ...(process.platform === "win32" ? { useConptyDll: true } : {})
      })
    );
  } catch (error) {
    ptyProbed = true;
    ptyLoadError = error instanceof Error ? error.message : String(error);

    // `-i` is what gives a piped POSIX shell its prompt and rc files. Under a
    // real pty it is unnecessary and confuses some shells' startup handling,
    // which is why it appears only here.
    const args = shell.args.length > 0 || process.platform === "win32" ? shell.args : ["-i"];

    return wrapChild(
      spawn(shell.file, args, {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      }) as ChildProcessWithoutNullStreams
    );
  }
}
