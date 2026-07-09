import { describe, expect, it } from "vitest";
import { generate, generateSecret, verify } from "otplib";
import { decryptSecret, encryptSecret } from "../../lib/encryption.js";

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

