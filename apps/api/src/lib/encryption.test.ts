import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./encryption.js";

describe("secret encryption", () => {
  it("round-trips encrypted secrets without exposing the original payload", () => {
    const encrypted = encryptSecret("smtp-secret", "test-master-key");

    expect(encrypted.encryptedPayload).not.toBe("smtp-secret");
    expect(encrypted.nonce).toBeTruthy();
    expect(encrypted.authTag).toBeTruthy();
    expect(decryptSecret(encrypted, "test-master-key")).toBe("smtp-secret");
  });

  it("fails when decrypting with the wrong master key", () => {
    const encrypted = encryptSecret("payment-secret", "correct-key");

    expect(() => decryptSecret(encrypted, "wrong-key")).toThrow();
  });
});

