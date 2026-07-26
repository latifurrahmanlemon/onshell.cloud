/**
 * Session cookie attribute resolution, kept separate from the auth routes so it
 * can be tested without standing up Fastify.
 */

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  domain?: string;
  path: "/";
}

/** True when `host` is genuinely covered by a cookie `Domain` like `.onshell.cloud`. */
export function hostMatchesCookieDomain(host: string, domain: string) {
  const bare = domain.replace(/^\./, "").toLowerCase();
  // The leading dot matters: "notonshell.cloud".endsWith("onshell.cloud") is true,
  // but it is a different registrable domain and must not match.
  return host === bare || host.endsWith(`.${bare}`);
}

/**
 * Derives the cookie attributes from the connection the cookie is being set on,
 * rather than from the configured canonical URL.
 *
 * Both attributes fail *silently* when they do not match the browser's reality: a
 * `Secure` cookie is discarded over plain HTTP, and a `Domain` the current host is
 * not under is rejected outright. Either one leaves login returning a token in the
 * response body while the very next request is unauthenticated — which presents as
 * "wrong password" and is not.
 *
 * So `Secure` follows the request scheme (which honours X-Forwarded-Proto when
 * TRUST_PROXY is on) unless COOKIE_SECURE was set explicitly, and `Domain` is only
 * sent when the request's own host actually falls under it. A deployment reachable
 * by IP or a temporary hostname keeps working before TLS and DNS are finished.
 */
export function resolveSessionCookie(
  request: { host: string | undefined; protocol: string },
  config: { cookieDomain?: string; cookieSecure?: boolean }
): SessionCookieOptions {
  const host = (request.host ?? "").split(":")[0].toLowerCase();
  const domain =
    config.cookieDomain && host && hostMatchesCookieDomain(host, config.cookieDomain)
      ? config.cookieDomain
      : undefined;

  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure ?? request.protocol === "https",
    domain,
    path: "/"
  };
}
