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
  TaskItem,
  AppNotification,
  HostWorkspace,
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
  terminalTheme: "onshell" | "nord" | "dracula" | "solarized" | "paper";
  hostThemes: Record<string, AppearanceSettings["terminalTheme"]>;
}

/**
 * Spelled out rather than reusing `NodeJS.Platform`: this file is compiled into
 * the renderer too, which has no Node types by design.
 */
export type Platform = "win32" | "darwin" | "linux" | (string & {});

/**
 * Everything the UI needs to decide what to render, in one object.
 *
 * Pushed on every change rather than polled, so the window cannot show a
 * signed-in console after the session was cleared in the main process.
 */
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
  { ok: true; user: User } | { ok: false; challenge: TwoFactorChallenge } | { ok: false; error: string };

/**
 * A browser sign-in the main process has started and is now polling for.
 *
 * The renderer gets the code to display and the URL to show in case the browser
 * did not open — and nothing else. The device secret that will collect the
 * token pair stays in the main process, for the reason in
 * `main/runtime/session.ts`.
 */
export type BrowserSignInStart =
  | {
      ok: true;
      /** The code the person must type into the browser to approve. */
      userCode: string;
      /** Where the browser was sent; shown so it can be opened by hand. */
      verificationUrl: string;
      expiresAt: string;
    }
  | { ok: false; error: string };

/** How the wait ended. `approved` is the only one that signs anybody in. */
export type BrowserSignInOutcome =
  | { status: "approved"; user: User }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

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

/** A restorable layout stores connection targets only — never terminal output or credentials. */
export interface SavedWorkspace {
  targets: TerminalTarget[];
  updatedAt?: string;
}

/**
 * A result rather than a thrown error, because a failed *direct* connection is
 * not simply a failure: it is a question for the user, and the answer — relay
 * instead, or not at all — is theirs. Electron also flattens a thrown Error
 * across IPC to its message alone, so `code` and `canRelay` would not survive
 * being raised.
 */
export type TerminalOpenResult =
  | { ok: true; terminal: TerminalOpened }
  | {
      ok: false;
      error: string;
      code?: string;
      /** True when going through the gateway would probably work instead. */
      canRelay?: boolean;
    };

export type TerminalEvent =
  | { terminalId: string; type: "data"; data: string }
  | { terminalId: string; type: "exit"; code?: number; reason?: string }
  | { terminalId: string; type: "status"; message: string };

/* ------------------------------------------------------------------ files */

/** One entry in a directory listing, from any of the three sources. */
export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
  /** Unix seconds. 0 when the entry could not be stat'ed. */
  modifiedAt: number;
}

export interface FileListing {
  /** The path the backend resolved — "." becomes absolute. */
  path: string;
  entries: FileEntry[];
}

export interface FileSessionOpened {
  fileSessionId: string;
  mode: "local" | "direct" | "relay";
  label: string;
  startPath: string;
}

export type FileSessionTargetRequest =
  | { kind: "local" }
  | { kind: "direct"; hostId: string; credentialId?: string }
  | { kind: "relay"; hostId: string; credentialId?: string };

/* ---------------------------------------------------------------- updates */

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  url?: string;
  checkedAt: string;
}

/* ---------------------------------------------------------------- sharing */

/** Who may open a session on this machine without someone here agreeing. */
export type ApprovalMode = "trusted" | "ask" | "always";

export interface SharingState {
  paired: boolean;
  running: boolean;
  ownerEmail?: string;
  approval: ApprovalMode;
  agentVersion: string;
  /** The local journal of every session served from this machine. */
  logPath: string;
}

/* ---------------------------------------------------------------- devices */

/** A machine this account has enrolled, as the settings screen lists it. */
export interface DesktopDeviceSummary {
  id: string;
  name: string;
  platform: string;
  appVersion?: string;
  lastSeenAt?: string;
  revokedAt?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------- api */

export interface ConsoleData {
  identity: CurrentIdentity;
  hosts: Host[];
  credentials: CredentialSummary[];
  snippets: Snippet[];
  tasks: TaskItem[];
  notifications: AppNotification[];
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
    /**
     * Hands sign-in to the user's real browser, where Google SSO, bot
     * protection, and an existing session all already work. Two calls rather
     * than one so the window can show the code the moment it has it, then wait.
     */
    startBrowserSignIn(): Promise<BrowserSignInStart>;
    awaitBrowserSignIn(): Promise<BrowserSignInOutcome>;
    cancelBrowserSignIn(): Promise<void>;
  };

  console: {
    load(): Promise<ConsoleData>;
    hosts(): Promise<Host[]>;
    createHost(input: Record<string, unknown>): Promise<Host>;
    updateHost(hostId: string, input: Record<string, unknown>): Promise<Host>;
    deleteHost(hostId: string): Promise<void>;
    snippets(): Promise<Snippet[]>;
    createSnippet(input: { name: string; command: string; scope: "personal" | "team" }): Promise<Snippet>;
    tasks(): Promise<TaskItem[]>;
    createTask(text: string): Promise<TaskItem>;
    updateTask(taskId: string, patch: { text?: string; completed?: boolean }): Promise<TaskItem>;
    deleteTask(taskId: string): Promise<void>;
    notifications(): Promise<AppNotification[]>;
    markNotificationRead(notificationId: string): Promise<void>;
    createCredential(input: { name: string; kind: "password" | "ssh_key" | "rdp_password"; secret: string; attachedHostIds: string[] }): Promise<CredentialSummary>;
    updateCredential(credentialId: string, input: { name?: string; attachedHostIds?: string[] }): Promise<CredentialSummary>;
    rotateCredential(credentialId: string, secret: string): Promise<CredentialSummary>;
    deleteCredential(credentialId: string): Promise<void>;
    workspaces(): Promise<HostWorkspace[]>;
    createWorkspace(input: { name: string; description?: string; hostIds: string[] }): Promise<HostWorkspace>;
    deleteWorkspace(workspaceId: string): Promise<void>;
    setFavorite(hostId: string, favorite: boolean): Promise<void>;
  };

  devices: {
    list(): Promise<DesktopDeviceSummary[]>;
    revoke(deviceId: string): Promise<void>;
  };

  /**
   * Offering this machine to the workspace — the opposite direction from
   * everything else here, and off until switched on.
   */
  sharing: {
    state(): Promise<SharingState>;
    start(name?: string): Promise<SharingState>;
    resume(): Promise<SharingState>;
    stop(): Promise<SharingState>;
    setApproval(mode: ApprovalMode): Promise<SharingState>;
    openLog(): Promise<void>;
  };

  files: {
    open(target: FileSessionTargetRequest): Promise<FileSessionOpened>;
    list(fileSessionId: string, path: string): Promise<FileListing>;
    read(fileSessionId: string, path: string): Promise<{ content: string; truncated: boolean }>;
    write(fileSessionId: string, path: string, content: string): Promise<void>;
    mkdir(fileSessionId: string, path: string): Promise<void>;
    move(fileSessionId: string, from: string, to: string): Promise<void>;
    remove(fileSessionId: string, path: string, recursive: boolean): Promise<void>;
    /** Copies one file between two open sessions, through this process. */
    transfer(fromSessionId: string, fromPath: string, toSessionId: string, toPath: string): Promise<void>;
    close(fileSessionId: string): Promise<void>;
  };

  terminals: {
    localShells(): Promise<LocalShell[]>;
    open(target: TerminalTarget): Promise<TerminalOpenResult>;
    write(terminalId: string, data: string): void;
    resize(terminalId: string, cols: number, rows: number): void;
    close(terminalId: string): Promise<void>;
    onEvent(handler: (event: TerminalEvent) => void): () => void;
  };

  workspace: {
    load(): Promise<SavedWorkspace>;
    save(targets: TerminalTarget[]): Promise<SavedWorkspace>;
  };

  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };

  settings: {
    update(patch: { connectionMode?: "direct" | "relay"; appearance?: Partial<AppearanceSettings> }): Promise<AppState>;
  };

  /**
   * Whether a newer release exists. Checking only — nothing downloads or
   * installs itself. Installer signing alone is not enough: an updater also
   * needs signed metadata, payload verification, staging, and rollback safety.
   */
  updates: {
    check(force?: boolean): Promise<UpdateStatus>;
  };

  /** Opens a URL in the user's real browser. Refused for anything but http(s). */
  openExternal(url: string): Promise<void>;
}

/** Channel names, in one place so a typo is a compile error rather than a silence. */
export const CHANNELS = {
  getState: "app:get-state",
  state: "app:state",
  clipboardReadText: "clipboard:read-text",
  clipboardWriteText: "clipboard:write-text",

  serverProbe: "server:probe",
  serverUse: "server:use",
  serverUseLocal: "server:use-local",

  signIn: "auth:sign-in",
  completeTwoFactor: "auth:complete-2fa",
  resendCode: "auth:resend-code",
  signOut: "auth:sign-out",
  browserSignInStart: "auth:browser-start",
  browserSignInAwait: "auth:browser-await",
  browserSignInCancel: "auth:browser-cancel",

  consoleLoad: "console:load",
  consoleHosts: "console:hosts",
  consoleCreateHost: "console:create-host",
  consoleUpdateHost: "console:update-host",
  consoleDeleteHost: "console:delete-host",
  consoleSnippets: "console:snippets",
  consoleCreateSnippet: "console:create-snippet",
  consoleTasks: "console:tasks",
  consoleCreateTask: "console:create-task",
  consoleUpdateTask: "console:update-task",
  consoleDeleteTask: "console:delete-task",
  consoleNotifications: "console:notifications",
  consoleReadNotification: "console:read-notification",
  consoleCreateCredential: "console:create-credential",
  consoleUpdateCredential: "console:update-credential",
  consoleRotateCredential: "console:rotate-credential",
  consoleDeleteCredential: "console:delete-credential",
  consoleWorkspaces: "console:workspaces",
  consoleCreateWorkspace: "console:create-workspace",
  consoleDeleteWorkspace: "console:delete-workspace",
  consoleSetFavorite: "console:set-favorite",

  sharingState: "sharing:state",
  sharingStart: "sharing:start",
  sharingResume: "sharing:resume",
  sharingStop: "sharing:stop",
  sharingApproval: "sharing:approval",
  sharingOpenLog: "sharing:open-log",

  devicesList: "devices:list",
  devicesRevoke: "devices:revoke",

  filesOpen: "files:open",
  filesList: "files:list",
  filesRead: "files:read",
  filesWrite: "files:write",
  filesMkdir: "files:mkdir",
  filesMove: "files:move",
  filesRemove: "files:remove",
  filesTransfer: "files:transfer",
  filesClose: "files:close",

  localShells: "terminal:local-shells",
  terminalOpen: "terminal:open",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalClose: "terminal:close",
  terminalEvent: "terminal:event",

  workspaceLoad: "workspace:load",
  workspaceSave: "workspace:save",

  updatesCheck: "updates:check",

  settingsUpdate: "settings:update",
  openExternal: "app:open-external"
} as const;
