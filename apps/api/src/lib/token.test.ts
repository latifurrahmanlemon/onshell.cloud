import { describe, expect, it } from "vitest";
import { createRefreshToken, hashToken, signAccessToken, verifyAccessToken } from "./token.js";

describe("auth tokens", () => {
  it("signs and verifies access tokens", () => {
    const token = signAccessToken(
      {
        sub: "user_1",
        email: "user@onshell.cloud",
        organizationId: "org_1",
        role: "owner",
        isPlatformAdmin: true
      },
      "jwt-secret",
      60
    );

    const payload = verifyAccessToken(token, "jwt-secret");
    expect(payload?.sub).toBe("user_1");
    expect(payload?.email).toBe("user@onshell.cloud");
    expect(payload?.isPlatformAdmin).toBe(true);
  });

  it("rejects access tokens signed with another secret", () => {
    const token = signAccessToken(
      {
        sub: "user_1",
        email: "user@onshell.cloud",
        organizationId: "org_1",
        role: "owner",
        isPlatformAdmin: true
      },
      "jwt-secret",
      60
    );

    expect(verifyAccessToken(token, "different-secret")).toBeUndefined();
  });

  it("hashes refresh tokens for database storage", () => {
    const refreshToken = createRefreshToken();
    const hashed = hashToken(refreshToken);

    expect(refreshToken).not.toBe(hashed);
    expect(hashed).toHaveLength(64);
  });
});

