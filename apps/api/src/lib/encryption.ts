import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedValue {
  encryptedPayload: string;
  nonce: string;
  authTag: string;
}

function deriveKey(masterKey: string) {
  return createHash("sha256").update(masterKey).digest();
}

export function encryptSecret(plainText: string, masterKey: string): EncryptedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterKey), nonce);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);

  return {
    encryptedPayload: encrypted.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

export function decryptSecret(value: EncryptedValue, masterKey: string) {
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterKey), Buffer.from(value.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(value.encryptedPayload, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

