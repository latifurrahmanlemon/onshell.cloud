import { describe, expect, it } from "vitest";
import { canUseLocalShell } from "./provisioning.js";

/**
 * This predicate is the only thing standing between a signed-up stranger and a
 * shell on the server running the platform, so the cases below are the failure
 * modes rather than a formality: it was previously an env flag, that flag was on
 * in production, and every account that signed up was handed one.
 *
 * The owner's address is not in this file, and not in the source under test —
 * only its hash is, because the repository is public. So these assert the shape
 * of the rule rather than a specific match: nobody is let in, whatever they send
 * and however privileged they are. The one positive case is covered by the
 * deployment that owns the hash, not by a test that would have to republish the
 * address to exist.
 */
describe("canUseLocalShell", () => {
  it("refuses every ordinary account, however privileged", () => {
    expect(canUseLocalShell({ email: "someone@example.com", isPlatformAdmin: true })).toBe(false);
    expect(canUseLocalShell({ email: "owner@customer.com", isPlatformAdmin: false })).toBe(false);
    expect(canUseLocalShell({ email: "admin@onshell.cloud", isPlatformAdmin: true })).toBe(false);
  });

  it("refuses an account that is not a platform admin, whatever the address", () => {
    expect(canUseLocalShell({ email: "anyone@anywhere.test", isPlatformAdmin: false })).toBe(false);
  });

  it("refuses malformed and injection-shaped addresses rather than throwing", () => {
    for (const email of [
      "",
      "   ",
      "not-an-email",
      '"someone@example.com" <attacker@evil.com>',
      "someone@example.com\nadmin@example.com"
    ]) {
      expect(canUseLocalShell({ email, isPlatformAdmin: true })).toBe(false);
    }
  });
});
