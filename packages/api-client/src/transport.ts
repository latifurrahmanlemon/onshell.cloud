/**
 * The HTTP plumbing under the Onshell API client.
 *
 * Two very different callers share this file. The browser console authenticates
 * with an httpOnly refresh cookie it cannot read, so its whole job is to send
 * `credentials: "include"` and let the server do the rest. The desktop app has
 * no cookie jar worth the name and no origin to be first-party to, so it holds a
 * bearer token in the OS keychain and attaches it by hand.
 *
 * Rather than fork the client, both are expressed as an `AuthStrategy`: a way to
 * decorate a request, and a way to recover from a 401 once. Everything above
 * this file — every endpoint in `endpoints.ts` — is then identical for both, so
 * the console and the desktop cannot drift on what a route means or returns.
 */

export class ApiError extends Error {
  status: number;
  /** The machine-readable `error` field, when the server sent one. */
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: string;
}

/**
 * How a caller proves who it is, and what it does when the server stops
 * believing it.
 */
export interface AuthStrategy {
  /**
   * Extra headers for one request — a bearer token, typically. Async so a token
   * store that has to touch the OS keychain does not have to cache eagerly.
   */
  headers?(path: string): Promise<Record<string, string>> | Record<string, string>;
  /** Whether the underlying fetch should carry cookies. */
  credentials?: RequestCredentials;
  /**
   * Called once on a 401. Return true if the caller should retry the request —
   * the token was rotated — and false if the session is genuinely over.
   *
   * Concurrency is this method's problem, not the caller's: several requests can
   * fail at the same moment and each will ask, so an implementation should share
   * one in-flight refresh between them.
   */
  refresh?(): Promise<boolean>;
}

export interface TransportOptions {
  /** API origin, no trailing slash — e.g. `https://onshell.cloud/api`. */
  baseUrl: string;
  auth?: AuthStrategy;
  /** Injectable for tests and for runtimes that wrap fetch. */
  fetch?: typeof fetch;
}

/**
 * Paths where a 401 is the answer rather than a stale-token symptom: signing in,
 * signing out, and the refresh call itself (retrying which would recurse).
 * Everything else — `/auth/me` included — is worth one silent retry, because the
 * access token expires long before the session does.
 *
 * `/invitations` is here for the opposite reason: those two routes authenticate
 * with the invite token, not a session, so a refresh could only ever swap in an
 * identity they do not read — and a caller with no session at all (the whole
 * point of the accept page) has nothing to refresh with.
 */
const NO_REFRESH_PATHS = [
  "/auth/login",
  "/auth/register",
  "/auth/logout",
  "/auth/refresh",
  "/auth/google",
  "/invitations"
];

export interface Transport {
  readonly baseUrl: string;
  request<T>(path: string, init?: RequestOptions): Promise<T>;
  /** Absolute URL for a path, for downloads the browser should navigate to. */
  url(path: string): string;
}

export function createTransport({ baseUrl, auth, fetch: fetchImpl }: TransportOptions): Transport {
  const base = baseUrl.replace(/\/+$/, "");
  const doFetch = fetchImpl ?? globalThis.fetch;

  async function request<T>(path: string, init?: RequestOptions, retried = false): Promise<T> {
    const authHeaders = auth?.headers ? await auth.headers(path) : {};
    const response = await doFetch(`${base}${path}`, {
      credentials: auth?.credentials,
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...authHeaders,
        ...init?.headers
      }
    });

    if (
      response.status === 401 &&
      !retried &&
      auth?.refresh &&
      !NO_REFRESH_PATHS.some((prefix) => path.startsWith(prefix))
    ) {
      if (await auth.refresh()) return request<T>(path, init, true);
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      const code = typeof body?.error === "string" ? body.error : undefined;
      // `message` when the server bothered to write one for a human, the error
      // code when it did not. Neither is guaranteed, hence the status fallback.
      const message =
        (typeof body?.message === "string" && body.message) || code || `Request failed (${response.status})`;
      throw new ApiError(response.status, message, code);
    }

    return payload as T;
  }

  return {
    baseUrl: base,
    request: (path, init) => request(path, init),
    url: (path) => `${base}${path}`
  };
}

/* -------------------------------------------------------------- strategies */

/**
 * Browser console auth: the refresh token is an httpOnly cookie, so there is
 * nothing to attach and nothing to store — `credentials: "include"` and a call
 * to `/auth/refresh` is the whole strategy.
 */
export function cookieAuth(options: { baseUrl: string; fetch?: typeof fetch } ): AuthStrategy & {
  /**
   * Renews ahead of time, for a console left open. `minAgeMs` keeps a user
   * flicking between windows from refreshing on every focus event.
   */
  keepAlive(minAgeMs?: number): Promise<boolean>;
} {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  let inFlight: Promise<boolean> | null = null;
  let lastRefreshAt = 0;

  function refresh(): Promise<boolean> {
    inFlight ??= doFetch(`${base}/auth/refresh`, { method: "POST", credentials: "include" })
      .then((response) => {
        if (response.ok) lastRefreshAt = Date.now();
        return response.ok;
      })
      .catch(() => false)
      .finally(() => {
        // Cleared on a timer rather than immediately: a burst of 401s from one
        // stale token should share a single refresh, not queue up behind it.
        setTimeout(() => {
          inFlight = null;
        }, 1000);
      });
    return inFlight;
  }

  return {
    credentials: "include",
    refresh,
    keepAlive(minAgeMs = 6 * 60 * 60 * 1000) {
      if (Date.now() - lastRefreshAt < minAgeMs) return Promise.resolve(true);
      return refresh();
    }
  };
}

/** What a bearer-token client hands the transport and gets back after a refresh. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface BearerAuthOptions {
  baseUrl: string;
  /** Current tokens, or undefined when signed out. */
  load(): Promise<TokenPair | undefined> | TokenPair | undefined;
  /** Persist a rotated pair. The desktop app writes these to the OS keychain. */
  save(tokens: TokenPair): Promise<void> | void;
  /** Called when the refresh token is rejected — the session is over. */
  clear(): Promise<void> | void;
  fetch?: typeof fetch;
}

/**
 * Desktop auth: an access token in memory, a refresh token in the OS keychain.
 *
 * Refresh tokens rotate on every use server-side, so the new pair must be
 * persisted before the retry goes out; dropping it would sign the user out on
 * the next restart with no visible cause.
 */
export function bearerAuth(options: BearerAuthOptions): AuthStrategy {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  let inFlight: Promise<boolean> | null = null;

  return {
    async headers(): Promise<Record<string, string>> {
      const tokens = await options.load();
      return tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {};
    },
    refresh() {
      inFlight ??= (async () => {
        const tokens = await options.load();
        if (!tokens?.refreshToken) return false;
        try {
          const response = await doFetch(`${base}/auth/refresh`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: tokens.refreshToken })
          });
          if (!response.ok) {
            // 401 here means the refresh token itself was rejected: revoked,
            // expired, or already used. Anything else is a transport problem
            // and must not sign the user out.
            if (response.status === 401) await options.clear();
            return false;
          }
          const payload = (await response.json()) as Partial<TokenPair>;
          if (!payload.accessToken || !payload.refreshToken) return false;
          await options.save({ accessToken: payload.accessToken, refreshToken: payload.refreshToken });
          return true;
        } catch {
          return false;
        } finally {
          setTimeout(() => {
            inFlight = null;
          }, 1000);
        }
      })();
      return inFlight;
    }
  };
}
