import { describe, expect, it } from "vitest";
import { generate, generateSecret, verify } from "otplib";
import { passwordPolicy, validatePassword } from "@onshell/shared";
import { decryptSecret, encryptSecret } from "../../lib/encryption.js";
import { createRefreshToken, hashToken, signAccessToken, verifyAccessToken } from "../../lib/token.js";

describe("TOTP two-factor flow helpers", () => {
  it("verifies a Google Authenticator compatible TOTP code after encrypted storage", async () => {
    const secret = generateSecret();
    const encrypted = encryptSecret(secret, "master-key");
    const restoredSecret = decryptSecret(encrypted, "master-key");
    const token = await generate({ secret: restoredSecret });
    const result = await verify({ secret: restoredSecret, token });

    expect(result.valid).toBe(true);
  });
});

describe("password policy", () => {
  it("requires at least 10 characters with lower, upper, digit and symbol", () => {
    expect(passwordPolicy.minLength).toBe(10);

    const result = validatePassword("Sup3r-Secret!");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a short password with every missing requirement listed", () => {
    const result = validatePassword("abc");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(4);
  });

  it("rejects passwords missing a single character class", () => {
    expect(validatePassword("nouppercase1!").valid).toBe(false);
    expect(validatePassword("NOLOWERCASE1!").valid).toBe(false);
    expect(validatePassword("NoDigitsHere!").valid).toBe(false);
    expect(validatePassword("NoSymbols123").valid).toBe(false);
  });
});

describe("token helpers used by refresh and OTP flows", () => {
  it("hashes tokens deterministically so stored hashes can be compared", () => {
    const otp = "042917";
    expect(hashToken(otp)).toBe(hashToken(otp));
    expect(hashToken(otp)).not.toBe(hashToken("042918"));
  });

  it("creates unique refresh tokens", () => {
    expect(createRefreshToken()).not.toBe(createRefreshToken());
  });

  it("round-trips an access token and rejects a tampered secret", () => {
    const payload = {
      sub: "user_1",
      email: "user@example.com",
      organizationId: "org_1",
      role: "owner",
      isPlatformAdmin: false
    };
    const token = signAccessToken(payload, "jwt-secret");

    const decoded = verifyAccessToken(token, "jwt-secret");
    expect(decoded?.sub).toBe("user_1");
    expect(verifyAccessToken(token, "other-secret")).toBeUndefined();
  });
});
