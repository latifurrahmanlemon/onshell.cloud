import { createHash, createHmac, randomBytes } from "node:crypto";

export interface AccessTokenPayload {
  sub: string;
  email: string;
  organizationId: string;
  role: string;
  isPlatformAdmin: boolean;
  exp: number;
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function signAccessToken(payload: Omit<AccessTokenPayload, "exp">, secret: string, ttlSeconds = 15 * 60) {
  const header = { alg: "HS256", typ: "JWT" };
  const body: AccessTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(body))}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");

  return `${unsigned}.${signature}`;
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | undefined {
  const [encodedHeader, encodedPayload, signature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !signature) return undefined;

  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", secret).update(unsigned).digest("base64url");
  if (expected !== signature) return undefined;

  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as AccessTokenPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) return undefined;
  return payload;
}

export function createRefreshToken() {
  return randomBytes(48).toString("base64url");
}

