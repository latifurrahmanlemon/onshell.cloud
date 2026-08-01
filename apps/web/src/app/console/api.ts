import type {
  AgentDevice,
  AuditLog,
  CredentialSummary,
  Host,
  Organization,
  RemoteSession,
  Role,
  Snippet,
  ThemePreference,
  User
} from "@onshell/shared";

export { apiBaseUrl, gatewayBaseUrl } from "../../lib/site";
import { apiBaseUrl, gatewayBaseUrl } from "../../lib/site";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let refreshPromise: Promise<boolean> | null = null;

/** Rotate the access token once; concurrent 401s share the same attempt. */
function tryRefresh(): Promise<boolean> {
  refreshPromise ??= fetch(`${apiBaseUrl}/auth/refresh`, { method: "POST", credentials: "include" })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      window.setTimeout(() => {
        refreshPromise = null;
      }, 1000);
    });
  return refreshPromise;
}

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init
  });

  if (response.status === 401 && !retried && !path.startsWith("/auth/")) {
    if (await tryRefresh()) return request<T>(path, init, true);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }

  return payload as T;
}

/** Accepts either a bare array or an object wrapper like { hosts: [...] }. */
function unwrapList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>)[key])) {
    return (payload as Record<string, T[]>)[key];
  }
  return [];
}

function unwrapItem<T>(payload: unknown, key: string): T {
  if (payload && typeof payload === "object" && key in (payload as Record<string, unknown>)) {
    return (payload as Record<string, T>)[key];
  }
  return payload as T;
}

export interface CurrentIdentity {
  user: User;
  organization?: Organization;
}

/** A member's effective host access, as returned alongside the team list. */
export interface MemberHostAccess {
  /** Reaches every host in the organization, including ones added later. */
  allHosts: boolean;
  /** Individually granted host ids. Empty when `allHosts` is true. */
  hostIds: string[];
  /** True when the access comes from the role (owner/admin) and cannot be edited. */
  implicit: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  role: Role;
  joinedAt?: string;
  twoFactorEnabled?: boolean;
  hostAccess?: MemberHostAccess;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  expiresAt?: string;
  createdAt?: string;
}

export interface InviteResult extends PendingInvitation {
  /**
   * False when SMTP is disabled or the send failed. The invitation is still
   * valid — it just has to be delivered by hand using `acceptUrl`.
   */
  emailSent: boolean;
  acceptUrl: string;
}

/**
 * A direct route to an agent running on the same machine as this browser.
 *
 * Offered by the API; whether it can actually be used is decided in the
 * browser, because only the browser knows if it is on that machine.
 */
export interface LocalRoute {
  port: number;
  ticket: string;
  deviceId?: string;
}

/**
 * Tries the loopback route, falling back to the tunnel.
 *
 * Three ways this legitimately fails, none of them worth showing the user:
 * the browser is on a different machine entirely (the common case), Safari
 * refuses `ws://127.0.0.1` from an https page, or endpoint software blocks
 * loopback listeners. The probe is given a short deadline for exactly that
 * reason — a session must not hang waiting to discover it is remote.
 *
 * The device id is checked because *something* answering on port 7681 is not
 * evidence it is the machine we were told to expect.
 */
async function resolveTerminalUrl(tunnelUrl: string | undefined, local?: LocalRoute) {
  if (!local || !tunnelUrl) return tunnelUrl;

  try {
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 700);
    const response = await fetch(`http://127.0.0.1:${local.port}/onshell/hello`, {
      signal: controller.signal,
      // Not `include`: this endpoint authenticates on the ticket alone, and
      // sending cookies to a loopback port would be a way to leak them.
      credentials: "omit"
    });
    window.clearTimeout(deadline);
    if (!response.ok) return tunnelUrl;

    const hello = (await response.json()) as { deviceId?: string };
    if (local.deviceId && hello.deviceId !== local.deviceId) return tunnelUrl;

    return `ws://127.0.0.1:${local.port}/onshell/session?ticket=${encodeURIComponent(local.ticket)}`;
  } catch {
    return tunnelUrl;
  }
}

export interface LaunchedSession {
  session: RemoteSession;
  websocketUrl?: string;
  localRoute?: LocalRoute;
  connectUrl?: string;
}

/** Source formats the host importer understands. */
export type HostImportFormat =
  | "onshell-json"
  | "termius-json"
  | "csv"
  | "ssh-config"
  | "putty-reg"
  | "rdp"
  | "rdcman";

export type HostExportFormat = "json" | "csv" | "ssh-config";

export interface HostImportPreviewRow {
  name: string;
  type: "ssh" | "rdp" | "vnc";
  address: string;
  port: number;
  username?: string;
  environment: "production" | "staging" | "development";
  tags: string[];
  group?: string;
  notes?: string;
  sourceRef: string;
  /** "new" will be created; the others are reported but not written. */
  disposition: "new" | "duplicate-in-file" | "exists";
}

export interface HostImportPreview {
  format: HostImportFormat;
  summary: { parsed: number; new: number; existing: number; duplicatesInFile: number; skipped: number };
  limit: {
    maxHosts: number | null;
    currentHosts: number;
    planName: string | null;
    wouldExceed: boolean;
    remaining: number | null;
  };
  hosts: HostImportPreviewRow[];
  truncatedPreview: boolean;
  issues: Array<{ sourceRef: string; message: string }>;
}

export interface HostImportResult {
  format: HostImportFormat;
  created: number;
  updated: number;
  skippedExisting: number;
  duplicatesInFile: number;
  failed: number;
  failures: Array<{ sourceRef: string; message: string }>;
  issues: Array<{ sourceRef: string; message: string }>;
}

export interface HostImportOptions {
  content: string;
  filename?: string;
  format?: HostImportFormat;
  environmentOverride?: "production" | "staging" | "development";
  groupOverride?: string;
  extraTags?: string[];
  onDuplicate?: "skip" | "update";
}

export interface AiThreadSummary {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export interface AiMessage {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  createdAt: string;
}

export interface AiThreadDetail extends AiThreadSummary {
  messages: AiMessage[];
}

export interface AiStatus {
  enabled: boolean;
  model: string | null;
  used: number;
  /** Null means unlimited on the current plan. */
  limit: number | null;
  remaining: number | null;
  planName: string | null;
}

export interface AiSendResult {
  thread: AiThreadSummary;
  userMessage: AiMessage;
  assistantMessage: AiMessage;
  usage: { used: number; limit: number | null; remaining: number | null };
}

/** One metered resource, as returned by GET /me/growth. */
export interface UsageEntry {
  used: number;
  limit: number | null;
  ratio: number | null;
  atLimit: boolean;
  nearLimit: boolean;
}

/** A plan as offered in the console's upgrade grid. */
export interface ConsolePlan {
  code: string;
  name: string;
  description: string;
  tagline: string | null;
  badge: string | null;
  isFree: boolean;
  isFeatured: boolean;
  displayOrder: number;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  maxUsers: number | null;
  maxHosts: number | null;
  maxConcurrentSessions: number | null;
  monthlyAiMessages: number | null;
  auditRetentionDays: number;
  trialDays: number;
  features: string[];
}

export type BillingInterval = "monthly" | "yearly";

export interface CheckoutStart {
  status: string;
  /** False when no payment provider is configured — the request became a sales enquiry. */
  selfServe: boolean;
  provider: string;
  checkoutUrl: string | null;
  plan: ConsolePlan;
  billingInterval: BillingInterval;
  message?: string;
}

export interface GrowthOverview {
  plan: (ConsolePlan & { id: string }) | null;
  plans: ConsolePlan[];
  canManageBilling: boolean;
  subscription: {
    id: string;
    status: string;
    billingInterval: string;
    currentPeriodEnd: string;
    trialEndsAt: string | null;
    cancelAt: string | null;
  } | null;
  usage: {
    members: UsageEntry;
    hosts: UsageEntry;
    concurrentSessions: UsageEntry;
    aiMessages: UsageEntry;
  };
  upgrade: { shouldPrompt: boolean; plan: ConsolePlan } | null;
  referral: { code: string | null; url: string; signups: number };
}

/* ------------------------------------------------------------------ files */

/** One entry in a remote directory listing. */
export interface RemoteFileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
  /** Unix seconds. 0 when the entry could not be stat'ed. */
  modifiedAt: number;
}

export interface RemoteDirectory {
  /** The path the server resolved — "." becomes an absolute path. */
  path: string;
  entries: RemoteFileEntry[];
}

/** Largest file the editor will open. Bigger files must be transferred, not edited. */
export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;

export interface RemoteFileContent {
  path: string;
  size: number;
  /** UTF-8 text. Absent when `binary` is true. */
  content?: string;
  /** True when the bytes are not valid UTF-8, so the editor must refuse. */
  binary: boolean;
  /** True when the file exceeded MAX_EDITABLE_FILE_BYTES and was not read. */
  tooLarge: boolean;
}

/* ------------------------------------------------------------- workspaces */

/** A saved set of hosts that can be opened as terminals in one action. */
export interface HostWorkspace {
  id: string;
  name: string;
  description?: string | null;
  hostIds: string[];
  createdAt: string;
  updatedAt: string;
}

export const consoleApi = {
  me: () => request<CurrentIdentity>("/auth/me"),
  logout: () => request<{ ok?: boolean }>("/auth/logout", { method: "POST" }),
  updateProfile: (body: { name?: string; avatarUrl?: string | null; themePreference?: ThemePreference | null }) =>
    request<{ user: User }>("/profile", { method: "PATCH", body: JSON.stringify(body) }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<{ ok?: boolean }>("/auth/password/change", { method: "POST", body: JSON.stringify(body) }),

  hosts: async () => unwrapList<Host>(await request("/hosts"), "hosts"),
  createHost: (body: Record<string, unknown>) => request<unknown>("/hosts", { method: "POST", body: JSON.stringify(body) }),
  updateHost: (id: string, body: Record<string, unknown>) =>
    request<unknown>(`/hosts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteHost: (id: string) => request<unknown>(`/hosts/${id}`, { method: "DELETE" }),

  previewHostImport: (body: { content: string; filename?: string; format?: HostImportFormat }) =>
    request<HostImportPreview>("/hosts/import/preview", { method: "POST", body: JSON.stringify(body) }),
  importHosts: (body: HostImportOptions) =>
    request<HostImportResult>("/hosts/import", { method: "POST", body: JSON.stringify(body) }),
  /**
   * Exports via a direct browser navigation rather than fetch: the response is a
   * file download with Content-Disposition, and letting the browser handle it
   * avoids buffering the whole export in memory just to build a blob.
   *
   * `ids` narrows the export to a hand-picked set. It is left off entirely when
   * empty so the URL stays the "everything I can see" export the API defaults to
   * — an `ids=` with no value would otherwise read as "export nothing".
   */
  hostExportUrl: (format: HostExportFormat, ids?: string[]) => {
    const params = new URLSearchParams({ format });
    if (ids && ids.length > 0) params.set("ids", ids.join(","));
    return `${apiBaseUrl}/hosts/export?${params.toString()}`;
  },

  agents: async () => unwrapList<AgentDevice>(await request("/agents"), "agents"),
  /**
   * Issues a pairing code. Returned once and never retrievable — only its hash
   * is stored — so the caller has to show it before navigating away.
   */
  createAgentPairingCode: () =>
    request<{ code: string; expiresAt: string }>("/agents/pairing-codes", { method: "POST" }),
  revokeAgent: (deviceId: string) => request<AgentDevice>(`/agents/${deviceId}/revoke`, { method: "POST" }),
  deleteAgent: (deviceId: string) => request<{ ok?: boolean }>(`/agents/${deviceId}`, { method: "DELETE" }),

  credentials: async () => unwrapList<CredentialSummary>(await request("/credentials"), "credentials"),
  createCredential: (body: Record<string, unknown>) =>
    request<unknown>("/credentials", { method: "POST", body: JSON.stringify(body) }),
  updateCredential: (id: string, body: { name?: string; attachedHostIds?: string[] }) =>
    request<unknown>(`/credentials/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  rotateCredential: (id: string, secret: string) =>
    request<unknown>(`/credentials/${id}/rotate`, { method: "POST", body: JSON.stringify({ secret }) }),
  deleteCredential: (id: string) => request<unknown>(`/credentials/${id}`, { method: "DELETE" }),

  sessions: async () => unwrapList<RemoteSession>(await request("/sessions"), "sessions"),
  openSession: async (body: { hostId: string; protocol: string; credentialId?: string; shell?: string }) => {
    const payload = await request<LaunchedSession>("/sessions", { method: "POST", body: JSON.stringify(body) });
    const websocketUrl = payload.websocketUrl ?? payload.connectUrl;
    return {
      session: unwrapItem<RemoteSession>(payload, "session"),
      // Prefers a direct connection when the agent turns out to be running on
      // this very machine; `resolveTerminalUrl` falls back to the tunnel for
      // every case where it does not.
      websocketUrl: await resolveTerminalUrl(websocketUrl, payload.localRoute)
    };
  },
  closeSession: (id: string) => request<unknown>(`/sessions/${id}/close`, { method: "POST" }),
  /**
   * Lists a directory on an open SFTP session. Goes through the API rather than
   * straight to the gateway so the request carries the caller's session and is
   * re-checked against their host access.
   */
  listFiles: (sessionId: string, path: string) =>
    request<{ path?: string; entries?: unknown[] }>(
      `/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`
    ),

  snippets: async () => unwrapList<Snippet>(await request("/snippets"), "snippets"),
  createSnippet: (body: Record<string, unknown>) =>
    request<unknown>("/snippets", { method: "POST", body: JSON.stringify(body) }),
  deleteSnippet: (id: string) => request<unknown>(`/snippets/${id}`, { method: "DELETE" }),

  audit: async (limit = 50) => unwrapList<AuditLog>(await request(`/audit?limit=${limit}`), "logs"),

  organization: () => request<Record<string, unknown>>("/organizations/current"),
  updateOrganization: (body: { name: string }) =>
    request<{ organization: Organization }>("/organizations/current", {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  invite: (body: { email: string; role: Role }) =>
    request<InviteResult>("/organizations/current/invitations", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  invitations: async () =>
    unwrapList<PendingInvitation>(await request("/organizations/current/invitations"), "invitations"),
  revokeInvitation: (id: string) =>
    request<unknown>(`/organizations/current/invitations/${id}`, { method: "DELETE" }),
  changeMemberRole: (userId: string, role: Role) =>
    request<unknown>(`/organizations/current/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeMember: (userId: string) =>
    request<unknown>(`/organizations/current/members/${userId}`, { method: "DELETE" }),
  memberHostAccess: (userId: string) =>
    request<MemberHostAccess>(`/organizations/current/members/${userId}/host-access`),
  setMemberHostAccess: (userId: string, body: { allHosts: boolean; hostIds: string[] }) =>
    request<MemberHostAccess>(`/organizations/current/members/${userId}/host-access`, {
      method: "PUT",
      body: JSON.stringify(body)
    }),

  twoFactorStatus: async () => {
    const payload = await request<{ twoFactorEnabled?: boolean; enabled?: boolean; method?: "totp" | "email" | null }>(
      "/auth/2fa/status"
    );
    return { enabled: payload.twoFactorEnabled ?? payload.enabled ?? false, method: payload.method ?? null };
  },
  setupTotp: () =>
    request<{ qrCodeDataUrl?: string; manualEntryKey?: string }>("/auth/2fa/setup", { method: "POST" }),
  verifyTotp: (totpCode: string) =>
    request<unknown>("/auth/2fa/verify", { method: "POST", body: JSON.stringify({ totpCode }) }),
  enableEmailOtp: () => request<unknown>("/auth/2fa/email/enable", { method: "POST" }),
  verifyEmailOtp: (code: string) =>
    request<unknown>("/auth/2fa/email/verify", { method: "POST", body: JSON.stringify({ code }) }),
  /** Emails the code needed to turn OFF email-based 2FA. */
  requestEmailOtpChallenge: () => request<unknown>("/auth/2fa/email/challenge", { method: "POST" }),
  disableTwoFactor: (totpCode: string) =>
    request<unknown>("/auth/2fa/disable", { method: "POST", body: JSON.stringify({ totpCode }) }),

  aiStatus: () => request<AiStatus>("/ai/status"),
  aiThreads: async () => unwrapList<AiThreadSummary>(await request("/ai/threads"), "threads"),
  aiThread: (id: string) => request<AiThreadDetail>(`/ai/threads/${id}`),
  aiRenameThread: (id: string, title: string) =>
    request<unknown>(`/ai/threads/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  aiDeleteThread: (id: string) => request<unknown>(`/ai/threads/${id}`, { method: "DELETE" }),
  aiSend: (body: { threadId?: string; message: string }) =>
    request<AiSendResult>("/ai/messages", { method: "POST", body: JSON.stringify(body) }),

  /* ---- files (all session-scoped, all via the API so host access is re-checked) ---- */
  readFile: (sessionId: string, path: string) =>
    request<RemoteFileContent>(`/sessions/${sessionId}/files/content?path=${encodeURIComponent(path)}`),
  writeFile: (sessionId: string, path: string, content: string) =>
    request<{ ok: true; size: number }>(`/sessions/${sessionId}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ path, content })
    }),
  makeDirectory: (sessionId: string, path: string) =>
    request<{ ok: true; path: string }>(`/sessions/${sessionId}/files/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  renamePath: (sessionId: string, from: string, to: string) =>
    request<{ ok: true; path: string }>(`/sessions/${sessionId}/files/rename`, {
      method: "POST",
      body: JSON.stringify({ from, to })
    }),
  deletePath: (sessionId: string, path: string, recursive = false) =>
    request<{ ok: true }>(
      `/sessions/${sessionId}/files?path=${encodeURIComponent(path)}&recursive=${recursive ? "true" : "false"}`,
      { method: "DELETE" }
    ),
  /**
   * Copies a file or directory from one open session to another — the paste half
   * of the dual-pane browser. Both sessions live in the same gateway process, so
   * the bytes never round-trip through the browser.
   */
  copyBetweenSessions: (body: { fromSessionId: string; fromPath: string; toSessionId: string; toPath: string }) =>
    request<{ ok: true; bytes: number; files: number }>(`/sessions/${body.fromSessionId}/files/copy`, {
      method: "POST",
      body: JSON.stringify({ path: body.fromPath, toSessionId: body.toSessionId, toPath: body.toPath })
    }),

  /* ---- host workspaces ---- */
  workspaces: async () => unwrapList<HostWorkspace>(await request("/host-workspaces"), "workspaces"),
  createWorkspace: (body: { name: string; description?: string; hostIds: string[] }) =>
    request<HostWorkspace>("/host-workspaces", { method: "POST", body: JSON.stringify(body) }),
  updateWorkspace: (id: string, body: { name?: string; description?: string | null; hostIds?: string[] }) =>
    request<HostWorkspace>(`/host-workspaces/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteWorkspace: (id: string) => request<unknown>(`/host-workspaces/${id}`, { method: "DELETE" }),

  growth: () => request<GrowthOverview>("/me/growth"),
  startCheckout: (body: { planCode: string; billingInterval: BillingInterval }) =>
    request<CheckoutStart>("/me/billing/checkout", { method: "POST", body: JSON.stringify(body) })
};

/** Resolve a session's terminal WebSocket URL, falling back to the gateway convention. */
export function sessionWebsocketUrl(session: RemoteSession, explicit?: string) {
  if (explicit && explicit.startsWith("ws")) return explicit;
  const base = gatewayBaseUrl.replace(/^http/, "ws");
  return `${base}/ws/${session.protocol}/${session.gatewaySessionId ?? session.id}`;
}
