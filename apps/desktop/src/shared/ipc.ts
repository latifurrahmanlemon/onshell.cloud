/**
 * The contract between the renderer and the main process.
 *
 * Shared by both sides so the preload, the handlers, and the UI cannot disagree
 * about a channel's shape. Read this file to know everything the renderer is
 * able to ask for — that is the whole point of keeping it in one place, and the
 * reason to be suspicious of any addition that takes a free-form path, command,
 * or URL.
 */
import type {
  AuditLog,
  CredentialSummary,
  CurrentIdentity,
  Host,
  RemoteSession,
  Snippet,
  User
} from "@onshell/api-client";

/* ------------------------------------------------------------------ state */

export interface ServerInfo {
  apiBaseUrl: string;
  gatewayBaseUrl: string;
  label: string;
}

export interface AppearanceSettings {
  theme: "system" | "dark" | "light";
  fontFamily: string;
  fontSize: number;
}

/**
 * Everything the UI needs to decide what to render, in one object.
 *
 * Pushed on every change rather than polled, so the window cannot show a signed
 * -in console after the session was cleared in the main process.
 */
/**
 * Spelled out rather than reusing `NodeJS.Platform`: this file is compiled into
 * the renderer too, which has no Node types by design.
 */
export type Platform = "win32" | "darwin" | "linux" | (string & {});

export interface AppState {
  version: string;
  platform: Platform;
  server?: ServerInfo;
  user?: User;
  /** False when the OS has no usable keychain, so sessions last one run. */
  keychainAvailable: boolean;
  connectionMode: "direct" | "relay";
  appearance: AppearanceSettings;
  sharing: { enabled: boolean };
}

/* --------------------------------------------------------------- sign-in */

export interface TwoFactorChallenge {
  requiresTwoFactor: true;
  method: "totp" | "email";
  challengeId: string;
  message?: string;
}

export type SignInResult =
  | { ok: true; user: User }
  | { ok: false; challenge: TwoFactorChallenge }
  | { ok: false; error: string };

/* -------------------------------------------------------------- terminals */

/** A shell this machine can offer, discovered at startup. */
export interface LocalShell {
  id: string;
  label: string;
  /** Absolute path to the executable, shown so the user can see what will run. */
  command: string;
  args: string[];
  isDefault: boolean;
}

export type TerminalTarget =
  /** This computer. No network, no server, no credential. */
  | { kind: "local"; shellId?: string; cwd?: string }
  /** A saved host, dialled straight from this machine. */
  | { kind: "direct"; hostId: string; credentialId?: string }
  /** A saved host, through the Onshell gateway, exactly like the browser does. */
  | { kind: "relay"; hostId: string; credentialId?: string; shell?: string };

export interface TerminalOpened {
  terminalId: string;
  /** Which path actually got used — never assumed by the UI, always reported. */
  mode: "local" | "direct" | "relay";
  title: string;
  /** Set for relay and direct sessions; absent for local ones. */
  sessionId?: string;
}

export type TerminalEvent =
  | { terminalId: string; type: "data"; data: string }
  | { terminalId: string; type: "exit"; code?: number; reason?: string }
  | { terminalId: string; type: "status"; message: string };

/* ------------------------------------------------------------------- api */

export interface ConsoleData {
  identity: CurrentIdentity;
  hosts: Host[];
  credentials: CredentialSummary[];
  snippets: Snippet[];
  sessions: RemoteSession[];
  audit: AuditLog[];
}

/**
 * The complete renderer-facing API. `window.onshell` is this, and nothing else.
 *
 * Note what is absent: no "run", no "readFile(path)", no "fetch(url)". Every
 * verb names a specific operation whose arguments the main process validates.
 * A channel that took an arbitrary path or command would hand a renderer bug
 * the whole machine.
 */
export interface OnshellBridge {
  getState(): Promise<AppState>;
  onState(handler: (state: AppState) => void): () => void;

  server: {
    probe(input: string): Promise<{ ok: boolean; message?: string; server?: ServerInfo }>;
    use(input: string): Promise<{ ok: boolean; message?: string }>;
    useLocalDevelopment(): Promise<{ ok: boolean; message?: string }>;
  };

  auth: {
    signIn(request: { email: string; password: string; totpCode?: string }): Promise<SignInResult>;
    completeTwoFactor(challengeId: string, code: string): Promise<SignInResult>;
    resendCode(challengeId: string): Promise<boolean>;
    signOut(): Promise<void>;
  };

  console: {
    load(): Promise<ConsoleData>;
    hosts(): Promise<Host[]>;
  };

  terminals: {
    localShells(): Promise<LocalShell[]>;
    open(target: TerminalTarget): Promise<TerminalOpened>;
    write(terminalId: string, data: string): void;
    resize(terminalId: string, cols: number, rows: number): void;
    close(terminalId: string): Promise<void>;
    onEvent(handler: (event: TerminalEvent) => void): () => void;
  };

  settings: {
    update(patch: {
      connectionMode?: "direct" | "relay";
      appearance?: Partial<AppearanceSettings>;
    }): Promise<AppState>;
  };

  /** Opens a URL in the user's real browser. Refused for anything but http(s). */
  openExternal(url: string): Promise<void>;
}

/** Channel names, in one place so a typo is a compile error rather than a silence. */
export const CHANNELS = {
  getState: "app:get-state",
  state: "app:state",

  serverProbe: "server:probe",
  serverUse: "server:use",
  serverUseLocal: "server:use-local",

  signIn: "auth:sign-in",
  completeTwoFactor: "auth:complete-2fa",
  resendCode: "auth:resend-code",
  signOut: "auth:sign-out",

  consoleLoad: "console:load",
  consoleHosts: "console:hosts",

  localShells: "terminal:local-shells",
  terminalOpen: "terminal:open",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalClose: "terminal:close",
  terminalEvent: "terminal:event",

  settingsUpdate: "settings:update",
  openExternal: "app:open-external"
} as const;
