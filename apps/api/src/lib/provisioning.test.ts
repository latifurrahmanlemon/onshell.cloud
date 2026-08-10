import { describe, expect, it } from "vitest";
import { LOCAL_SHELL_OWNER_EMAIL, canUseLocalShell } from "./provisioning.js";

/**
 * This predicate is the only thing standing between a signed-up stranger and a
 * shell on the server running the platform, so the cases below are the failure
 * modes rather than a formality: it was previously an env flag, that flag was on
 * in production, and every account that signed up was handed one.
 */
describe("canUseLocalShell", () => {
  const owner = { email: LOCAL_SHELL_OWNER_EMAIL, isPlatformAdmin: true };

  it("allows the platform admin it is hardcoded to", () => {
    expect(canUseLocalShell(owner)).toBe(true);
  });

  it("ignores case and stray whitespace in the address", () => {
    expect(canUseLocalShell({ ...owner, email: `  ${LOCAL_SHELL_OWNER_EMAIL.toUpperCase()} ` })).toBe(true);
  });

  it("refuses any other account, however privileged", () => {
    expect(canUseLocalShell({ email: "someone@example.com", isPlatformAdmin: true })).toBe(false);
    expect(canUseLocalShell({ email: "owner@customer.com", isPlatformAdmin: false })).toBe(false);
  });

  it("refuses the owner's address once the account is no longer a platform admin", () => {
    expect(canUseLocalShell({ ...owner, isPlatformAdmin: false })).toBe(false);
  });

  it("refuses look-alike addresses rather than matching loosely", () => {
    const [local, domain] = LOCAL_SHELL_OWNER_EMAIL.split("@");
    for (const email of [
      `${local}@evil.com`,
      `x${local}@${domain}`,
      `${local}@${domain}.evil.com`,
      `${local}+admin@${domain}`,
      `"${local}@${domain}" <attacker@evil.com>`
    ]) {
      expect(canUseLocalShell({ email, isPlatformAdmin: true })).toBe(false);
    }
  });
});
