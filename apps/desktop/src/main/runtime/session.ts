/**
 * The signed-in session: the API client, and the sign-in flows that produce it.
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
 *
 * That boundary is also what shapes the browser sign-in at the bottom of this
 * file: the renderer is handed a user code to display and a promise that
 * resolves to "you are signed in". The device secret and the token pair it
 * collects never cross the bridge.
 */
import { ApiError, bearerAuth, createApiClient, type ApiClient, type TokenPair } from "@onshell/api-client";
import type { User } from "@onshell/shared";
import type { BrowserSignInOutcome, BrowserSignInStart } from "../../shared/ipc.js";
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

/** Everything either auth leg can send back, successful or not. */
type AuthPayload = Partial<LoginResponse> &
  Partial<TwoFactorChallenge> & {
    error?: string;
    message?: string;
    errors?: string[];
    retryAfterSeconds?: number;
  };

/**
 * One HTTP attempt, with "never answered" kept distinct from "answered badly".
 *
 * Collapsing the two is how a DNS failure ends up reported as a rejected
 * password. They are different problems with different fixes and the user has to
 * be told which one they have.
 */
interface AuthAttempt {
  status?: number;
  payload?: AuthPayload | null;
  /** Set when the request never got an answer: DNS, TLS, refused, timed out. */
  transportError?: string;
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

/* --------------------------------------------------------- error reporting */

/**
 * Turns a failed sign-in into a sentence a person can act on.
 *
 * Every branch here exists because the alternative was worse. The screen used to
 * render `payload.message ?? payload.error`, which meant:
 *
 *  * a rejected password showed the literal string `invalid_credentials`;
 *  * a Fastify 404 showed `Route POST:/auth/login not found`, blaming the
 *    password for a wrong server address;
 *  * a Turnstile-protected deployment showed "Please complete the bot-protection
 *    challenge" in a window that has no challenge to complete and no way to
 *    render one;
 *  * and a DNS failure showed nothing at all, because the fetch threw and the
 *    button simply stayed on "Signing in…".
 *
 * The code is mapped first and `payload.message` is only used as a fallback,
 * because for several of these the server's own wording is written for a browser
 * and is a dead end here.
 *
 * The 401 copy deserves a note. The API cannot distinguish "wrong password" from
 * "this account has no password" in its response, and it must not: an endpoint
 * that said "this address exists but signs in with Google" would be an account
 * enumeration oracle for anyone with a word list. So the answer is to say both
 * possibilities in the one message the app already shows. A Google-only account
 * is a real and common case — `/auth/login` returns `invalid_credentials` for it
 * unconditionally, so a password sign-in for such an account can never succeed —
 * and the user needs to be pointed at the browser, not left retrying a password
 * that does not exist. The hint costs nothing: it is shown to everyone who fails
 * a password sign-in, so it reveals nothing about any particular address.
 */
function describeAuthFailure(attempt: AuthAttempt, leg: "login" | "twoFactor"): string {
  if (attempt.transportError) return attempt.transportError;

  const status = attempt.status ?? 0;
  const payload = attempt.payload ?? null;
  const code = payload?.error;
  const retry = payload?.retryAfterSeconds;

  switch (code) {
    case "invalid_credentials":
      return (
        "That email and password did not match an account on this server. " +
        "If you sign in to Onshell with Google, use “Sign in with browser” instead — " +
        "a Google account has no password to type here."
      );
    case "invalid_two_factor_code":
      return "That verification code was not accepted. Codes expire quickly, so try the current one.";
    case "two_factor_code_required":
      return "Enter the verification code before continuing.";
    case "two_factor_challenge_not_found":
      return "This sign-in took too long and has expired. Start again from the beginning.";
    case "too_many_attempts":
      return "Too many incorrect codes. Start the sign-in again.";
    case "too_many_login_attempts":
      return retry
        ? `Too many failed attempts for this account. Try again in ${retry} seconds.`
        : "Too many failed attempts for this account. Wait a few minutes and try again.";
    case "rate_limited":
      return retry
        ? `This server is refusing further attempts from your network for ${retry} seconds.`
        : "This server is refusing further attempts from your network. Wait a minute and try again.";
    case "captcha_required":
    case "captcha_failed":
      // The app cannot render a Turnstile widget, and pretending otherwise wastes
      // the user's time. The browser can, so send them there.
      return (
        "This server requires a bot-protection challenge to sign in, which this window cannot show. " +
        "Use “Sign in with browser” instead."
      );
    case "captcha_unavailable":
      return "This server's bot protection is not answering, so it cannot accept a sign-in right now. Try again shortly.";
    case "password_policy_violation":
      return payload?.errors?.length
        ? payload.errors.join(" ")
        : "That password does not meet this server's requirements.";
    case "validation_failed":
      return "Check the email address and try again.";
    case "user_not_found":
      return "That account no longer exists on this server.";
    case "unauthorized":
      return "This server did not accept the sign-in. Try again.";
    case "internal_error":
      // Never the user's fault and never actionable by them, so do not dress it
      // up as a credential problem. The server log has the real reason.
      return "This server hit an internal error while signing you in. Try again — if it keeps happening, its log will say why.";
    default:
      break;
  }

  // A 404 on an auth route is not a credential problem: there is no Onshell API
  // at that address. Say that, because the fix is the server field.
  if (status === 404) {
    return server
      ? `There is no Onshell API at ${server.apiBaseUrl}. Check the server address, then try again.`
      : "There is no Onshell API at that address.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "This server is up but its API is not answering. Try again in a moment.";
  }

  // Anything left: use the server's own wording only if it reads like a
  // sentence. A bare snake_case code is a machine string and must not be shown.
  const message = payload?.message;
  if (message && !/^[a-z][a-z0-9_]*$/.test(message)) return message;
  if (payload === null && status > 0) {
    return `The server at ${server?.label ?? "that address"} did not answer with an Onshell API response (HTTP ${status}).`;
  }
  return leg === "login" ? `Sign-in failed (HTTP ${status}).` : `The code could not be checked (HTTP ${status}).`;
}

/**
 * Why the request never arrived, in the user's terms.
 *
 * Node's fetch reports every transport failure as `TypeError: fetch failed` and
 * hides the useful part in `cause.code`, which is the difference between "you
 * typed the address wrong" and "your server is down".
 */
function describeTransportFailure(error: unknown): string {
  const address = server?.label ?? "the server";
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;

  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `${address} did not answer in time. Check the address and your connection, then try again.`;
  }
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not find ${address}. Check the server address and your connection.`;
    case "ECONNREFUSED":
      return `Nothing is answering at ${address}. The server may be down, or the address may be wrong.`;
    case "ECONNRESET":
    case "EPIPE":
      return `The connection to ${address} was cut off. Try again.`;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return `${address} has an HTTPS certificate this machine will not trust, so the sign-in was not sent.`;
    default:
      return `Could not reach ${address}. Check the server address and your connection.`;
  }
}

/** POSTs JSON and reports the outcome without ever throwing at the caller. */
async function postAuth(path: string, body: unknown, headers?: Record<string, string>): Promise<AuthAttempt> {
  try {
    const response = await fetch(`${server?.apiBaseUrl ?? ""}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      // Long enough for a bcrypt comparison over a slow link, short enough that
      // an unreachable host does not leave the button spinning indefinitely.
      signal: AbortSignal.timeout(20_000)
    });
    // A proxy error page is HTML, not JSON. `null` here means "answered, but not
    // like an API", which describeAuthFailure reports as exactly that.
    const payload = (await response.json().catch(() => null)) as AuthPayload | null;
    return { status: response.status, payload };
  } catch (error) {
    return { transportError: describeTransportFailure(error) };
  }
}

/* ------------------------------------------------------------- the session */

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

  const attempt = await postAuth("/auth/login", request);
  const payload = attempt.payload;

  // 202 is the server saying the password was right and it wants a code.
  if (attempt.status === 202 && payload?.requiresTwoFactor && payload.challengeId) {
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

  if (!payload?.accessToken || !payload.refreshToken || !payload.user) {
    return { ok: false, error: describeAuthFailure(attempt, "login") };
  }

  return { ok: true, user: await persist(payload as LoginResponse) };
}

/** Second leg of a 2FA sign-in: the code, against the challenge id. */
export async function completeTwoFactor(challengeId: string, code: string): Promise<SignInResult> {
  if (!server) return { ok: false, error: "No Onshell server configured." };

  const attempt = await postAuth("/auth/2fa/complete", { challengeId, code });
  const payload = attempt.payload;

  if (!payload?.accessToken || !payload.refreshToken || !payload.user) {
    return { ok: false, error: describeAuthFailure(attempt, "twoFactor") };
  }

  return { ok: true, user: await persist(payload as LoginResponse) };
}

/** Emails a fresh code for an email-2FA challenge that timed out. */
export async function resendTwoFactorCode(challengeId: string): Promise<boolean> {
  if (!server) return false;
  const attempt = await postAuth("/auth/2fa/challenge/resend", { challengeId });
  return attempt.status !== undefined && attempt.status >= 200 && attempt.status < 300;
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
  cancelBrowserSignIn();
  await clearTokens();
  identity = undefined;
}

/* ------------------------------------------------------ browser sign-in */

/**
 * Signing in by handing the whole thing to the user's real browser.
 *
 * A native window can offer a password and nothing else. It cannot run Google's
 * SSO redirect, it cannot render a Turnstile widget, and it knows nothing about
 * the session the user's browser is very likely already holding. So instead of
 * reimplementing any of that, the app asks the server for a pending sign-in,
 * opens the browser at it, and waits to be told a signed-in human approved it.
 *
 * The user code is the part that matters. It is displayed in this window and
 * typed into the browser by the person, which is what ties the approval to the
 * machine that asked for it: a request started by an attacker elsewhere cannot
 * be approved by someone who was merely sent a link, because they have no code
 * to type. The app therefore has to show the code prominently and the server
 * deliberately never puts it in the URL. See lib/desktop-auth.ts on the API
 * side for the whole argument.
 *
 * The device secret returned at creation stays in this process. It is the only
 * thing that can collect the resulting token pair, and it is exactly the kind of
 * short-lived credential the renderer must never see.
 */
interface PendingBrowserSignIn {
  requestId: string;
  deviceSecret: string;
  userCode: string;
  verificationUrl: string;
  pollIntervalMs: number;
  expiresAt: number;
  /** The one live timer for this request. Cleared on every exit path. */
  timer?: NodeJS.Timeout;
  /** Resolves the renderer's `awaitBrowserSignIn` call, exactly once. */
  settle?: (outcome: BrowserSignInOutcome) => void;
}

interface CreateResponse {
  requestId?: string;
  deviceSecret?: string;
  userCode?: string;
  verificationUrl?: string;
  pollIntervalSeconds?: number;
  expiresAt?: string;
}

interface PollResponse {
  status?: "pending" | "approved" | "denied" | "expired";
  pollIntervalSeconds?: number;
  user?: User;
  accessToken?: string;
  refreshToken?: string;
  error?: string;
}

let pending: PendingBrowserSignIn | undefined;

/**
 * The single exit path. Clearing the timer here rather than at each call site is
 * what keeps a cancelled or finished request from leaving an interval running
 * against a window that has since closed.
 */
function settleBrowserSignIn(outcome: BrowserSignInOutcome) {
  const request = pending;
  pending = undefined;
  if (!request) return;
  if (request.timer) clearTimeout(request.timer);
  request.timer = undefined;
  request.settle?.(outcome);
  request.settle = undefined;
}

/** Asks the server for a pending sign-in. The caller opens the URL it returns. */
export async function startBrowserSignIn(machine: {
  machineName: string;
  platform: string;
  appVersion?: string;
}): Promise<BrowserSignInStart> {
  if (!server) return { ok: false, error: "No Onshell server configured." };

  // A second attempt supersedes the first rather than racing it: two pollers
  // against two requests would leave whichever lost holding a live timer.
  settleBrowserSignIn({ status: "cancelled" });

  const attempt = await postAuth("/desktop/auth/requests", machine);
  const payload = attempt.payload as (AuthPayload & CreateResponse) | null;

  if (!payload?.requestId || !payload.deviceSecret || !payload.userCode || !payload.verificationUrl) {
    // A server too old to know this route answers 404, which describeAuthFailure
    // reads as "no Onshell API here" — accurate for the endpoint, misleading for
    // the deployment, so say what is actually missing.
    if (attempt.status === 404) {
      return {
        ok: false,
        error: "This server does not support signing in from the browser yet. Use your email and password."
      };
    }
    return { ok: false, error: describeAuthFailure(attempt, "login") };
  }

  pending = {
    requestId: payload.requestId,
    deviceSecret: payload.deviceSecret,
    userCode: payload.userCode,
    verificationUrl: payload.verificationUrl,
    pollIntervalMs: Math.max(1, payload.pollIntervalSeconds ?? 2) * 1000,
    expiresAt: payload.expiresAt ? new Date(payload.expiresAt).getTime() : Date.now() + 5 * 60 * 1000
  };

  return {
    ok: true,
    userCode: pending.userCode,
    verificationUrl: pending.verificationUrl,
    expiresAt: new Date(pending.expiresAt).toISOString()
  };
}

/**
 * Waits for the browser. Resolves once — approved, refused, expired, cancelled,
 * or failed — and never leaves a timer behind, because every path goes through
 * `settleBrowserSignIn`.
 */
export function awaitBrowserSignIn(): Promise<BrowserSignInOutcome> {
  const request = pending;
  if (!request) return Promise.resolve({ status: "cancelled" });

  return new Promise<BrowserSignInOutcome>((resolve) => {
    request.settle = resolve;

    const poll = async () => {
      // Cancelled or superseded while the last request was in flight.
      if (pending !== request) return;

      if (Date.now() >= request.expiresAt) {
        settleBrowserSignIn({ status: "expired" });
        return;
      }

      const attempt = await postAuth(
        `/desktop/auth/requests/${encodeURIComponent(request.requestId)}/poll`,
        {},
        { "x-onshell-device-secret": request.deviceSecret }
      );
      if (pending !== request) return;

      // A blip in the network is not a failed sign-in. Keep asking until the
      // request's own deadline decides the matter.
      if (attempt.transportError) {
        request.timer = setTimeout(() => void poll(), request.pollIntervalMs);
        return;
      }

      const payload = attempt.payload as PollResponse | null;
      if (attempt.status === 401) {
        settleBrowserSignIn({
          status: "failed",
          error: "This machine's sign-in request was rejected by the server. Start again."
        });
        return;
      }
      if (attempt.status === 429) {
        // Backed off rather than abandoned: the server is asking us to slow down.
        request.timer = setTimeout(() => void poll(), request.pollIntervalMs * 4);
        return;
      }

      switch (payload?.status) {
        case "approved":
          if (!payload.accessToken || !payload.refreshToken || !payload.user) {
            settleBrowserSignIn({
              status: "failed",
              error: "The server approved the sign-in but did not return a session. Try again."
            });
            return;
          }
          // Straight through `persist`, so this produces exactly the state a
          // password sign-in produces — same keychain write, same identity.
          settleBrowserSignIn({
            status: "approved",
            user: await persist({
              user: payload.user,
              accessToken: payload.accessToken,
              refreshToken: payload.refreshToken
            })
          });
          return;
        case "denied":
          settleBrowserSignIn({ status: "denied" });
          return;
        case "expired":
          settleBrowserSignIn({ status: "expired" });
          return;
        case "pending":
          if (payload.pollIntervalSeconds) {
            request.pollIntervalMs = Math.max(1, payload.pollIntervalSeconds) * 1000;
          }
          request.timer = setTimeout(() => void poll(), request.pollIntervalMs);
          return;
        default:
          settleBrowserSignIn({ status: "failed", error: describeAuthFailure(attempt, "login") });
      }
    };

    request.timer = setTimeout(() => void poll(), request.pollIntervalMs);
  });
}

/** The Cancel button, and every other reason to stop waiting. */
export function cancelBrowserSignIn() {
  settleBrowserSignIn({ status: "cancelled" });
}
