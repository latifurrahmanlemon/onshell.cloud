import { describe, expect, it } from "vitest";
import type { TurnstileSetting } from "@prisma/client";
import { isTurnstileUsable } from "./turnstile.js";

/**
 * Regression cover for a lockout: `verifyTurnstile` used to enforce on the raw
 * `enabled` column while the browser only rendered a widget when a site key was
 * also present. A row with `enabled = true` and no site key therefore rejected
 * every login with `captcha_required` over a challenge that was never displayed —
 * including for the admin who would have gone and switched it off.
 *
 * Both sides now read `isTurnstileUsable`, so these cases cannot diverge again.
 */
function setting(overrides: Partial<TurnstileSetting> = {}): TurnstileSetting {
  return {
    id: "global",
    siteKey: "0x4AAAAAAA_site",
    encryptedSecretKey: "ciphertext",
    secretKeyNonce: "nonce",
    secretKeyAuthTag: "tag",
    enabled: true,
    protectSignup: true,
    protectLogin: true,
    protectPasswordReset: true,
    protectContact: true,
    protectCheckout: true,
    protectNewsletter: true,
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  } as TurnstileSetting;
}

describe("isTurnstileUsable", () => {
  it("is usable when switched on with both keys", () => {
    expect(isTurnstileUsable(setting())).toBe(true);
  });

  it("is not usable when it has never been configured", () => {
    expect(isTurnstileUsable(null)).toBe(false);
  });

  it("is not usable when switched off", () => {
    expect(isTurnstileUsable(setting({ enabled: false }))).toBe(false);
  });

  it("is not usable without a site key, because no widget can be rendered", () => {
    expect(isTurnstileUsable(setting({ siteKey: null }))).toBe(false);
    expect(isTurnstileUsable(setting({ siteKey: "" }))).toBe(false);
  });

  it("is not usable without a stored secret, because no token could be verified", () => {
    expect(isTurnstileUsable(setting({ encryptedSecretKey: null }))).toBe(false);
  });
});
