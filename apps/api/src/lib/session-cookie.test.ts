import { describe, expect, it } from "vitest";
import { resolveSessionCookie } from "./session-cookie.js";

/**
 * These guard a failure mode that is invisible from the server's side: the login
 * response looks perfect (200 + token) while the browser silently discards the
 * cookie, so the next request is unauthenticated and the UI reports bad
 * credentials.
 */
describe("session cookie attributes", () => {
  it("omits Secure over plain http so the cookie is not discarded", () => {
    const options = resolveSessionCookie(
      { host: "203.0.113.10:5018", protocol: "http" },
      { cookieDomain: ".onshell.cloud", cookieSecure: undefined }
    );

    expect(options.secure).toBe(false);
    // .onshell.cloud cannot apply to a bare IP, so no Domain is sent at all.
    expect(options.domain).toBeUndefined();
  });

  it("sets Secure and the shared Domain on the real https domain", () => {
    const options = resolveSessionCookie(
      { host: "api.onshell.cloud", protocol: "https" },
      { cookieDomain: ".onshell.cloud", cookieSecure: undefined }
    );

    expect(options.secure).toBe(true);
    expect(options.domain).toBe(".onshell.cloud");
  });

  it("applies the shared Domain to the apex host too", () => {
    const options = resolveSessionCookie(
      { host: "onshell.cloud", protocol: "https" },
      { cookieDomain: ".onshell.cloud", cookieSecure: undefined }
    );

    expect(options.domain).toBe(".onshell.cloud");
  });

  it("drops a Domain the current host is not under", () => {
    // Mid-DNS-cutover, or a staging hostname: sending .onshell.cloud here would
    // make the browser reject the cookie outright.
    const options = resolveSessionCookie(
      { host: "onshell.staging.example.com", protocol: "https" },
      { cookieDomain: ".onshell.cloud", cookieSecure: undefined }
    );

    expect(options.domain).toBeUndefined();
    expect(options.secure).toBe(true);
  });

  it("is not fooled by a domain that is only a suffix match", () => {
    // "notonshell.cloud" ends with "onshell.cloud" as a substring but is a
    // different registrable domain.
    const options = resolveSessionCookie(
      { host: "notonshell.cloud", protocol: "https" },
      { cookieDomain: ".onshell.cloud", cookieSecure: undefined }
    );

    expect(options.domain).toBeUndefined();
  });

  it("lets an explicit COOKIE_SECURE override the request scheme", () => {
    // TLS terminated by a proxy that does not forward X-Forwarded-Proto.
    expect(
      resolveSessionCookie({ host: "onshell.cloud", protocol: "http" }, { cookieSecure: true }).secure
    ).toBe(true);

    expect(
      resolveSessionCookie({ host: "onshell.cloud", protocol: "https" }, { cookieSecure: false }).secure
    ).toBe(false);
  });

  it("always keeps the cookie HttpOnly, SameSite=Lax, and site-wide", () => {
    const options = resolveSessionCookie({ host: "onshell.cloud", protocol: "https" }, {});

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });

  it("tolerates a missing Host header", () => {
    const options = resolveSessionCookie({ host: undefined, protocol: "https" }, { cookieDomain: ".onshell.cloud" });
    expect(options.domain).toBeUndefined();
  });
});
