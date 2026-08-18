/**
 * The signed-in session: the API client, and the sign-in flow that produces it.
 *
 * All API traffic goes through the main process, never the renderer. Two reasons,
 * and the second is the important one:
 *
 *  1. There is no origin for the server to trust, so cookies are out and bearer
 *     tokens are in — and a bearer token handed to a renderer is a bearer token
 *     one XSS away from leaving the machine.
 *  2. The renderer is where UI bugs live. Keeping the token, the credential
 *     leases, and the sockets on this side means a renderer compromise costs the
 *     attacker a window, not a workspace.
 */
import { ApiError, bearerAuth, createApiClient, type ApiClient, type TokenPair } from "@onshell/api-client";
import type { User } from "@onshell/shared";
import { clearTokens, loadTokens, saveTokens } from "./vault.js";
import type { ServerConfig } from "./settings.js";

export interface SignInRequest {
  email: string;
  password: string;
  totpCode?: string;
}

/** What the server said when a password alone was not enough. */
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

interface LoginResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

let client: ApiClient | undefined;
let server: ServerConfig | undefined;
let identity: User | undefined;

/**
 * Points the app at a server. Called at startup with the saved configuration and
 * again whenever the user changes it; the old client is dropped rather than
 * reconfigured, so no in-flight request can land against the wrong deployment.
 */
export function useServer(config: ServerConfig) {
  server = config;
  identity = undefined;
  client = createApiClient({
    baseUrl: config.apiBaseUrl,
    gatewayBaseUrl: config.gatewayBaseUrl,
    auth: bearerAuth({
      baseUrl: config.apiBaseUrl,
      load: loadTokens,
      save: saveTokens,
      clear: async () => {
        await clearTokens();
        identity = undefined;
      }
    })
  });
  return client;
}

export function currentServer() {
  return server;
}

export function currentUser() {
  return identity;
}

/** The API client, or undefined before a server has been chosen. */
export function api() {
  return client;
}

/** Throwing accessor for the many call sites that cannot proceed without one. */
export function requireApi(): ApiClient {
  if (!client) throw new Error("No Onshell server configured");
  return client;
}

/**
 * Checks whether a URL is actually an Onshell API before it is saved.
 *
 * Without this, a typo becomes a login screen that rejects a correct password
 * with no explanation. `/health` needs no authentication precisely so it can
 * answer this question.
 */
export async function probeServer(config: ServerConfig): Promise<{ ok: boolean; message?: string }> {
  try {
    const response = await fetch(`${config.apiBaseUrl}/health`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return { ok: false, message: `The server answered ${response.status} at /health.` };

    // The gateway answers /health too, and pointing the app at it would fail
    // later with an unhelpful 404 on every call. It names itself, so ask.
    const health = (await response.json().catch(() => null)) as { service?: string } | null;
    if (health?.service && health.service !== "api") {
      return { ok: false, message: `That address is the ${health.service}, not the Onshell API.` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not reach that address."
    };
  }
}

/** Rehydrates an existing session at startup. Returns undefined when signed out. */
export async function restoreSession(): Promise<User | undefined> {
  if (!client) return undefined;
  const tokens = await loadTokens();
  if (!tokens?.refreshToken) return undefined;
  try {
    // Goes out with a possibly-empty access token on purpose: the 401 that
    // follows is what drives the refresh, which is the only way to find out
    // whether the stored session is still good.
    const { user } = await client.me();
    identity = user;
    return user;
  } catch {
    return undefined;
  }
}

async function persist(response: LoginResponse) {
  const tokens: TokenPair = { accessToken: response.accessToken, refreshToken: response.refreshToken };
  await saveTokens(tokens);
  identity = response.user;
  return response.user;
}

/** Password sign-in. May come back asking for a second factor instead. */
export async function signIn(request: SignInRequest): Promise<SignInResult> {
  if (!server) return { ok: false, error: "No Onshell server configured." };

  const response = await fetch(`${server.apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  const payload = (await response.json().catch(() => null)) as
    | (Partial<LoginResponse> & Partial<TwoFactorChallenge> & { error?: string; message?: string })
    | null;

  // 202 is the server saying the password was right and it wants a code.
  if (response.status === 202 && payload?.requiresTwoFactor && payload.challengeId) {
    return {
      ok: false,
      challenge: {
        requiresTwoFactor: true,
        method: payload.method ?? "totp",
        challengeId: payload.challengeId,
        message: payload.message
      }
    };
  }

  if (!response.ok || !payload?.accessToken || !payload.refreshToken || !payload.user) {
    return { ok: false, error: payload?.message ?? payload?.error ?? `Sign-in failed (${response.status}).` };
  }

  return { ok: true, user: await persist(payload as LoginResponse) };
}

/** Second leg of a 2FA sign-in: the code, against the challenge id. */
export async function completeTwoFactor(challengeId: string, code: string): Promise<SignInResult> {
  if (!server) return { ok: false, error: "No Onshell server configured." };

  const response = await fetch(`${server.apiBaseUrl}/auth/2fa/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, code })
  });
  const payload = (await response.json().catch(() => null)) as
    | (Partial<LoginResponse> & { error?: string; message?: string })
    | null;

  if (!response.ok || !payload?.accessToken || !payload.refreshToken || !payload.user) {
    return { ok: false, error: payload?.message ?? payload?.error ?? "That code was not accepted." };
  }

  return { ok: true, user: await persist(payload as LoginResponse) };
}

/** Emails a fresh code for an email-2FA challenge that timed out. */
export async function resendTwoFactorCode(challengeId: string): Promise<boolean> {
  if (!server) return false;
  try {
    const response = await fetch(`${server.apiBaseUrl}/auth/2fa/challenge/resend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId })
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function signOut() {
  // Best-effort: the local session is gone either way, and a server that cannot
  // be reached must not leave the user apparently still signed in. The refresh
  // token it would have revoked expires on its own.
  try {
    await client?.logout();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
  await clearTokens();
  identity = undefined;
}
