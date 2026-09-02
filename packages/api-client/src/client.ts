/**
 * The Onshell API surface, as one object.
 *
 * Every endpoint the console and the desktop app use lives here exactly once.
 * That is the point of the package: two clients written separately drift, and a
 * drift in what `POST /sessions` means is the kind that ends with a terminal
 * connected to the wrong thing.
 *
 * Nothing in this file knows whether it is running in a tab or in Electron. The
 * difference is the `AuthStrategy` handed to `createTransport`, and the optional
 * `probeLocalRoute` hook, which is the one behaviour a browser and a desktop
 * genuinely have to answer differently.
 */
import type { Transport, TransportOptions } from "./transport.js";
import { createTransport } from "./transport.js";
import type {
  AcceptInvitationResult,
  AccountSession,
  AgentDevice,
  AiSendResult,
  AiStatus,
  AiThreadDetail,
  AiThreadSummary,
  AuditLog,
  CheckoutStart,
  CredentialSummary,
  CurrentIdentity,
  GrowthOverview,
  Host,
  HostExportFormat,
  HostImportFormat,
  HostImportOptions,
  HostImportPreview,
  HostImportResult,
  HostWorkspace,
  InvitationPreview,
  InviteResult,
  LaunchedSession,
  LocalRoute,
  MemberHostAccess,
  Organization,
  OrganizationList,
  OrganizationSwitchResult,
  PendingInvitation,
  RemoteFileContent,
  RemoteSession,
  Role,
  Snippet,
  TaskItem,
  AppNotification,
  ThemePreference,
  User
} from "./types.js";

/** Accepts either a bare array or an object wrapper like `{ hosts: [...] }`. */
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

export interface ApiClientOptions extends TransportOptions {
  /** Gateway origin, used to build terminal WebSocket URLs. */
  gatewayBaseUrl: string;
  /**
   * Given the loopback route the API offered, decide whether this machine can
   * actually use it, and return the URL to connect to. Returning undefined —
   * or not supplying the hook at all — means "use the tunnel".
   *
   * A browser answers this by probing `127.0.0.1`; the desktop app knows the
   * answer without asking, because it *is* the machine.
   */
  probeLocalRoute?(local: LocalRoute): Promise<string | undefined>;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(options: ApiClientOptions) {
  const transport: Transport = createTransport(options);
  const request = transport.request;
  const gatewayBaseUrl = options.gatewayBaseUrl.replace(/\/+$/, "");

  /** Prefers a loopback route to an agent on this machine; falls back to the tunnel. */
  async function resolveTerminalUrl(tunnelUrl: string | undefined, local?: LocalRoute) {
    if (!local || !tunnelUrl || !options.probeLocalRoute) return tunnelUrl;
    try {
      return (await options.probeLocalRoute(local)) ?? tunnelUrl;
    } catch {
      return tunnelUrl;
    }
  }

  return {
    transport,
    gatewayBaseUrl,

    me: () => request<CurrentIdentity>("/auth/me"),
    logout: () => request<{ ok?: boolean }>("/auth/logout", { method: "POST" }),
    updateProfile: (body: { name?: string; avatarUrl?: string | null; themePreference?: ThemePreference | null }) =>
      request<{ user: User }>("/profile", { method: "PATCH", body: JSON.stringify(body) }),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      request<{ ok?: boolean }>("/auth/password/change", { method: "POST", body: JSON.stringify(body) }),

    /** Every machine signed in to this account — one entry per sign-in, not per token. */
    accountSessions: async () => (await request<{ sessions: AccountSession[] }>("/auth/sessions")).sessions,
    /**
     * Ends one other session. The API refuses the caller's own — signing this
     * one out is what `logout` is for, and it clears the local credentials too.
     */
    revokeAccountSession: (sessionId: string) =>
      request<{ ok: boolean; revoked: number }>(`/auth/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE"
      }),
    /** Ends every session except the caller's own. */
    revokeOtherAccountSessions: () =>
      request<{ ok: boolean; revoked: number }>("/auth/sessions", { method: "DELETE" }),

    hosts: async () => unwrapList<Host>(await request("/hosts"), "hosts"),
    createHost: (body: Record<string, unknown>) =>
      request<Host>("/hosts", { method: "POST", body: JSON.stringify(body) }),
    updateHost: (id: string, body: Record<string, unknown>) =>
      request<Host>(`/hosts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteHost: (id: string) => request<unknown>(`/hosts/${id}`, { method: "DELETE" }),
    /** Pin or unpin a host for the signed-in account. Both calls are idempotent. */
    setHostFavorite: (id: string, favorite: boolean) =>
      request<{ ok: boolean; isFavorite: boolean }>(`/hosts/${id}/favorite`, {
        method: favorite ? "PUT" : "DELETE"
      }),

    previewHostImport: (body: { content: string; filename?: string; format?: HostImportFormat }) =>
      request<HostImportPreview>("/hosts/import/preview", { method: "POST", body: JSON.stringify(body) }),
    importHosts: (body: HostImportOptions) =>
      request<HostImportResult>("/hosts/import", { method: "POST", body: JSON.stringify(body) }),
    /**
     * The export is a file download with `Content-Disposition`, so callers hand
     * this URL to whatever downloads things — a browser navigation, or the
     * desktop app's save dialog — rather than buffering the whole export in
     * memory to build a blob.
     *
     * `ids` narrows the export to a hand-picked set. It is left off entirely
     * when empty so the URL stays the "everything I can see" export the API
     * defaults to; an `ids=` with no value would read as "export nothing".
     */
    hostExportUrl: (format: HostExportFormat, ids?: string[]) => {
      const params = new URLSearchParams({ format });
      if (ids && ids.length > 0) params.set("ids", ids.join(","));
      return transport.url(`/hosts/export?${params.toString()}`);
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
      request<CredentialSummary>("/credentials", { method: "POST", body: JSON.stringify(body) }),
    updateCredential: (id: string, body: { name?: string; attachedHostIds?: string[] }) =>
      request<CredentialSummary>(`/credentials/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    rotateCredential: (id: string, secret: string) =>
      request<CredentialSummary>(`/credentials/${id}/rotate`, { method: "POST", body: JSON.stringify({ secret }) }),
    deleteCredential: (id: string) => request<unknown>(`/credentials/${id}`, { method: "DELETE" }),

    sessions: async () => unwrapList<RemoteSession>(await request("/sessions"), "sessions"),
    openSession: async (body: { hostId: string; protocol: string; credentialId?: string; shell?: string }) => {
      const payload = await request<LaunchedSession>("/sessions", { method: "POST", body: JSON.stringify(body) });
      const websocketUrl = payload.websocketUrl ?? payload.connectUrl;
      return {
        session: unwrapItem<RemoteSession>(payload, "session"),
        websocketUrl: await resolveTerminalUrl(websocketUrl, payload.localRoute)
      };
    },
    closeSession: (id: string) => request<unknown>(`/sessions/${id}/close`, { method: "POST" }),
    /**
     * Lists a directory on an open SFTP session. Goes through the API rather
     * than straight to the gateway so the request carries the caller's session
     * and is re-checked against their host access.
     */
    listFiles: (sessionId: string, path: string) =>
      request<{ path?: string; entries?: unknown[] }>(
        `/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`
      ),

    snippets: async () => unwrapList<Snippet>(await request("/snippets"), "snippets"),
    createSnippet: (body: Record<string, unknown>) =>
      request<Snippet>("/snippets", { method: "POST", body: JSON.stringify(body) }),
    deleteSnippet: (id: string) => request<unknown>(`/snippets/${id}`, { method: "DELETE" }),

    tasks: async () => unwrapList<TaskItem>(await request("/tasks"), "tasks"),
    createTask: (text: string) => request<TaskItem>("/tasks", { method: "POST", body: JSON.stringify({ text }) }),
    updateTask: (id: string, body: { text?: string; completed?: boolean }) =>
      request<TaskItem>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteTask: (id: string) => request<unknown>(`/tasks/${id}`, { method: "DELETE" }),
    notifications: async () => unwrapList<AppNotification>(await request("/notifications"), "notifications"),
    markNotificationRead: (id: string) => request<{ ok: true }>(`/notifications/${id}/read`, { method: "POST" }),
    publishNotification: (body: { title: string; message: string; actionUrl?: string; expiresAt?: string }) =>
      request<AppNotification>("/admin/notifications", { method: "POST", body: JSON.stringify(body) }),

    audit: async (limit = 50) => unwrapList<AuditLog>(await request(`/audit?limit=${limit}`), "logs"),

    /**
     * Every workspace this account belongs to. Distinct from `organization()`
     * below, which describes the one workspace the session is currently in.
     */
    myOrganizations: () => request<OrganizationList>("/auth/organizations"),
    /**
     * Points the session at another of the caller's workspaces, re-issuing it
     * against that workspace's membership and role.
     *
     * 404 (`organization_not_found`) for a workspace the caller is not a member
     * of — the API does not distinguish that from one that does not exist, so
     * this is not a way to probe for organization ids.
     *
     * Everything the caller had loaded belongs to the *previous* workspace and
     * must be discarded: hosts, credentials, sessions, and above all open
     * terminals, which stay connected to machines the new workspace has no claim
     * on. A bearer client also has to keep the returned pair, which `adopt` does
     * for it here — without that it would carry on using the token naming the
     * workspace it just left.
     */
    switchOrganization: async (organizationId: string) => {
      const result = await request<OrganizationSwitchResult>(
        `/auth/organizations/${encodeURIComponent(organizationId)}/switch`,
        { method: "POST" }
      );
      if (result.accessToken && result.refreshToken && options.auth?.adopt) {
        await options.auth.adopt({ accessToken: result.accessToken, refreshToken: result.refreshToken });
      }
      return result;
    },

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
    /**
     * Reads an invitation without accepting it, so the accept page can name the
     * workspace and decide whether to ask for a password.
     *
     * Unauthenticated, unlike everything above it: the token from the emailed
     * link is the credential, and the recipient may not have an account yet.
     * Throws `ApiError` with status 404 for a token that is unknown, expired, or
     * already used — the API does not distinguish the three.
     */
    lookupInvitation: (token: string) =>
      request<InvitationPreview>(`/invitations/lookup?token=${encodeURIComponent(token)}`),
    /**
     * Accepts an invitation. Also unauthenticated.
     *
     * `name` and `password` are required only when the invited address has no
     * account yet — `existingUser: false` from the lookup — and are rejected as
     * missing rather than guessed at. Accepting as a new user creates the
     * account and returns a session; accepting for an existing one only adds the
     * membership, and the person still has to sign in.
     */
    acceptInvitation: (body: { token: string; name?: string; password?: string }) =>
      request<AcceptInvitationResult>("/invitations/accept", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    changeMemberRole: (userId: string, role: Role) =>
      request<unknown>(`/organizations/current/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      }),
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
      const payload = await request<{
        twoFactorEnabled?: boolean;
        enabled?: boolean;
        method?: "totp" | "email" | null;
      }>("/auth/2fa/status");
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
     * Copies a file or directory from one open session to another — the paste
     * half of the dual-pane browser. Both sessions live in the same gateway
     * process, so the bytes never round-trip through the client.
     */
    copyBetweenSessions: (body: {
      fromSessionId: string;
      fromPath: string;
      toSessionId: string;
      toPath: string;
    }) =>
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
    startCheckout: (body: { planCode: string; billingInterval: BillingIntervalArg }) =>
      request<CheckoutStart>("/me/billing/checkout", { method: "POST", body: JSON.stringify(body) })
  };
}

type BillingIntervalArg = "monthly" | "yearly";

/** Resolve a session's terminal WebSocket URL, falling back to the gateway convention. */
export function sessionWebsocketUrl(gatewayBaseUrl: string, session: RemoteSession, explicit?: string) {
  if (explicit && explicit.startsWith("ws")) return explicit;
  const base = gatewayBaseUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/ws/${session.protocol}/${session.gatewaySessionId ?? session.id}`;
}
