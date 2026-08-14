import { describe, expect, it } from "vitest";
import { REFRESH_ROTATION_GRACE_MS, isRefreshTokenUsable } from "./refresh-token-policy.js";

const now = new Date("2026-08-14T12:00:00.000Z");
const inThirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

describe("refresh token acceptance", () => {
  it("accepts a live token", () => {
    expect(isRefreshTokenUsable({ revokedAt: null, expiresAt: inThirtyDays }, now)).toBe(true);
  });

  it("rejects a missing token", () => {
    expect(isRefreshTokenUsable(null, now)).toBe(false);
  });

  it("rejects an expired token even though it was never revoked", () => {
    expect(isRefreshTokenUsable({ revokedAt: null, expiresAt: new Date(now.getTime() - 1) }, now)).toBe(false);
  });

  it("accepts a token rotated a moment ago, so parallel tabs do not sign each other out", () => {
    const rotated = { revokedAt: new Date(now.getTime() - 5_000), expiresAt: inThirtyDays };
    expect(isRefreshTokenUsable(rotated, now)).toBe(true);
  });

  it("rejects a token once the rotation grace has passed", () => {
    const rotated = {
      revokedAt: new Date(now.getTime() - REFRESH_ROTATION_GRACE_MS - 1),
      expiresAt: inThirtyDays
    };
    expect(isRefreshTokenUsable(rotated, now)).toBe(false);
  });

  it("rejects a signed-out token, which is expired at the same moment it is revoked", () => {
    // What revokeRefreshTokens writes: revokedAt = expiresAt = the sign-out.
    const signedOut = { revokedAt: now, expiresAt: now };
    expect(isRefreshTokenUsable(signedOut, new Date(now.getTime() + 1_000))).toBe(false);
  });
});
