import type {
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

export const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
export const gatewayBaseUrl = process.env.NEXT_PUBLIC_GATEWAY_BASE_URL ?? "http://localhost:4100";

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

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt?: string;
  twoFactorEnabled?: boolean;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  expiresAt?: string;
  createdAt?: string;
}

export interface LaunchedSession {
  session: RemoteSession;
  websocketUrl?: string;
  connectUrl?: string;
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

  credentials: async () => unwrapList<CredentialSummary>(await request("/credentials"), "credentials"),
  createCredential: (body: Record<string, unknown>) =>
    request<unknown>("/credentials", { method: "POST", body: JSON.stringify(body) }),
  rotateCredential: (id: string, secret: string) =>
    request<unknown>(`/credentials/${id}/rotate`, { method: "POST", body: JSON.stringify({ secret }) }),
  deleteCredential: (id: string) => request<unknown>(`/credentials/${id}`, { method: "DELETE" }),

  sessions: async () => unwrapList<RemoteSession>(await request("/sessions"), "sessions"),
  openSession: async (body: { hostId: string; protocol: string; credentialId?: string }) => {
    const payload = await request<LaunchedSession>("/sessions", { method: "POST", body: JSON.stringify(body) });
    return {
      session: unwrapItem<RemoteSession>(payload, "session"),
      websocketUrl: payload.websocketUrl ?? payload.connectUrl
    };
  },
  closeSession: (id: string) => request<unknown>(`/sessions/${id}/close`, { method: "POST" }),

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
    request<unknown>("/organizations/current/invitations", { method: "POST", body: JSON.stringify(body) }),
  invitations: async () =>
    unwrapList<PendingInvitation>(await request("/organizations/current/invitations"), "invitations"),
  revokeInvitation: (id: string) =>
    request<unknown>(`/organizations/current/invitations/${id}`, { method: "DELETE" }),
  changeMemberRole: (userId: string, role: Role) =>
    request<unknown>(`/organizations/current/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeMember: (userId: string) =>
    request<unknown>(`/organizations/current/members/${userId}`, { method: "DELETE" }),

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
    request<unknown>("/auth/2fa/email/verify", { method: "POST", body: JSON.stringify({ code }) })
};

/** Resolve a session's terminal WebSocket URL, falling back to the gateway convention. */
export function sessionWebsocketUrl(session: RemoteSession, explicit?: string) {
  if (explicit && explicit.startsWith("ws")) return explicit;
  const base = gatewayBaseUrl.replace(/^http/, "ws");
  return `${base}/ws/${session.protocol}/${session.gatewaySessionId ?? session.id}`;
}
