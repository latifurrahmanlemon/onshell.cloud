/**
 * Which shells this machine can actually offer.
 *
 * Discovery happens once at startup and the result is advertised in the `hello`
 * frame. The gateway may then only ask for a token from that list — it cannot
 * name a path or a command line — so this file is the complete set of programs
 * Onshell can ever start on the customer's machine. Keep it that way.
 */
import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { ShellDescriptor } from "@onshell/agent-protocol";

export interface ResolvedShell extends ShellDescriptor {
  /** Absolute path to the executable. Never crosses the wire. */
  file: string;
  args: string[];
}

async function exists(path: string) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds an executable on PATH.
 *
 * Deliberately not `which`/`where`: shelling out to find a shell is circular,
 * costs a process per candidate, and on Windows `where` resolves against the
 * current directory first — which would let a `pwsh.exe` dropped in the working
 * directory win over the real one.
 */
async function findOnPath(name: string) {
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = platform() === "win32" ? [name, `${name}.exe`] : [name];

  for (const entry of entries) {
    for (const candidate of candidates) {
      const full = join(entry, candidate);
      if (await exists(full)) return full;
    }
  }

  return undefined;
}

/**
 * WSL distributions registered on this machine.
 *
 * Three things make this less trivial than it looks:
 *
 * 1. `wsl.exe` exists on every modern Windows install **even when WSL is not
 *    installed at all** — it is a stub that prints an advert for `wsl --install`
 *    and exits non-zero. Testing for the file is therefore useless; the exit
 *    code is the only reliable signal, and treating stdout as a distro list
 *    would offer "The Windows Subsystem for Linux is not installed." as a shell.
 * 2. The output is UTF-16LE with a BOM. Decoded as UTF-8 it comes back with a
 *    NUL between every character, which is how you get a distro named
 *    `U`, `b`, `u`, `n`, `t`, `u`.
 * 3. Distro names are user-chosen and may contain characters a shell token
 *    cannot carry, so the token is sanitised while the real name is kept for
 *    the command line.
 */
async function discoverWslDistros(systemRoot: string): Promise<ResolvedShell[]> {
  const wsl = join(systemRoot, "System32", "wsl.exe");
  if (!(await exists(wsl))) return [];

  const listed = await new Promise<Buffer | undefined>((resolve) => {
    execFile(
      wsl,
      ["-l", "-q"],
      // A machine whose WSL service is starting can take a moment; a machine
      // where it is broken must not hold up agent startup for ever.
      { encoding: "buffer", timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout)
    ).on("error", () => resolve(undefined));
  });
  if (!listed) return [];

  const names = listed
    .toString("utf16le")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    // A stray NUL or control character means the decoding assumption was wrong
    // for this Windows build; drop the line rather than spawn something odd.
    .filter((line) => line.length > 0 && !/[\u0000-\u001f]/.test(line));

  const taken = new Set<string>();
  return names.map((name, index) => {
    // A token's variant part has to start with an alphanumeric, so a name like
    // "-scratch" must not become the unparseable token `wsl:-scratch`.
    const safe = name.replace(/[^A-Za-z0-9._+-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
    let token = `wsl:${safe.length > 0 ? safe : `distro${index}`}`;
    // Two distros can sanitise to the same token ("a b" and "a_b"); the index
    // keeps them addressable rather than silently collapsing into one.
    if (taken.has(token)) token = `${token}-${index}`;
    taken.add(token);

    return {
      token,
      label: `${name} (WSL)`,
      default: false,
      file: wsl,
      args: ["-d", name]
    };
  });
}

async function discoverWindowsShells() {
  const shells: ResolvedShell[] = [];
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";

  // Windows PowerShell ships with the OS. Addressed by absolute path rather
  // than via PATH so a shadowing powershell.exe earlier in PATH cannot take its
  // place.
  const windowsPowerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (await exists(windowsPowerShell)) {
    shells.push({
      token: "powershell",
      label: "Windows PowerShell",
      default: true,
      file: windowsPowerShell,
      args: ["-NoLogo"]
    });
  }

  // PowerShell 7+ is a separate, optional install.
  const pwsh = await findOnPath("pwsh");
  if (pwsh) {
    shells.push({
      token: "pwsh",
      label: "PowerShell 7",
      // Preferred over Windows PowerShell when both exist: it is the one under
      // active development, and anybody who installed it wants it.
      default: true,
      file: pwsh,
      args: ["-NoLogo"]
    });
  }

  const comspec = process.env.COMSPEC ?? join(systemRoot, "System32", "cmd.exe");
  if (await exists(comspec)) {
    shells.push({
      token: "cmd",
      label: "Command Prompt",
      default: shells.length === 0,
      file: comspec,
      args: []
    });
  }

  // Listed after the native shells: a Windows machine's default terminal is a
  // Windows one, and WSL is the deliberate choice.
  shells.push(...(await discoverWslDistros(systemRoot)));

  // Only one default survives: the last one flagged wins, everything else is cleared.
  const lastDefault = shells.map((shell) => shell.default).lastIndexOf(true);
  return shells.map((shell, index) => ({ ...shell, default: index === lastDefault }));
}

/**
 * Login shells this system considers legitimate.
 *
 * `/etc/shells` is the canonical list on both macOS and Linux, and it is what
 * catches the shells a `$PATH` sweep misses — a Homebrew fish in
 * `/opt/homebrew/bin`, or a nix-installed zsh — because a login shell must be
 * listed here for `chsh` to accept it in the first place.
 */
async function readEtcShells() {
  try {
    return (await readFile("/etc/shells", "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"));
  } catch {
    return [];
  }
}

async function discoverPosixShells() {
  const shells: ResolvedShell[] = [];
  const preferred = process.env.SHELL;
  const listed = await readEtcShells();

  const candidates = ["zsh", "bash", "fish", "sh"];

  for (const name of candidates) {
    // Prefer whatever `/etc/shells` names, since that is the copy the system
    // sanctions; fall back to a PATH sweep for a machine without the file.
    const fromEtc = listed.find((path) => basename(path) === name);
    const file = fromEtc ?? (await findOnPath(name));
    if (!file || !(await exists(file))) continue;

    shells.push({
      token: name,
      label: name,
      // The login shell is what someone expects a terminal to open.
      default: preferred === file,
      file,
      args: []
    });
  }

  // No $SHELL match (common in a stripped service environment): fall back to
  // the first discovered shell so the list always has exactly one default.
  if (shells.length > 0 && !shells.some((shell) => shell.default)) {
    shells[0] = { ...shells[0]!, default: true };
  }

  return shells;
}

export async function discoverShells(): Promise<ResolvedShell[]> {
  return platform() === "win32" ? discoverWindowsShells() : discoverPosixShells();
}

export function resolveShell(shells: ResolvedShell[], token: string) {
  return shells.find((shell) => shell.token === token);
}

/** Strips the local paths before the list goes over the wire. */
export function toDescriptors(shells: ResolvedShell[]): ShellDescriptor[] {
  return shells.map(({ token, label, default: isDefault }) => ({ token, label, default: isDefault }));
}

export function defaultCwd() {
  return homedir();
}

export function machineArch() {
  return arch();
}
