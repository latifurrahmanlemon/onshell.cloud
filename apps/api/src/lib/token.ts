import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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

/**
 * Lifetime of the access JWT. Deliberately short next to the session itself:
 * nothing can withdraw a signed token before it expires, so a revoked device
 * keeps working for at most this long. The refresh cookie is what makes a
 * session last a month.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export function signAccessToken(
  payload: Omit<AccessTokenPayload, "exp">,
  secret: string,
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS
) {
  const header = { alg: "HS256", typ: "JWT" };
  const body: AccessTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(body))}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");

  return `${unsigned}.${signature}`;
}

/**
 * Constant-time signature comparison. A plain `!==` leaks how many leading
 * bytes of a forged signature were correct, which is enough to reconstruct a
 * valid tag one byte at a time over many requests.
 */
function signatureMatches(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | undefined {
  const parts = token.split(".");
  // Exactly three segments — a token with extra dots must not verify.
  if (parts.length !== 3) return undefined;

  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) return undefined;

  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", secret).update(unsigned).digest("base64url");
  if (!signatureMatches(expected, signature)) return undefined;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
      alg?: unknown;
    };
    // Pin the algorithm so a token claiming `alg: none` can never be accepted
    // if the verification path is ever refactored.
    if (header.alg !== "HS256") return undefined;

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as AccessTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return undefined;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return undefined;
    return payload;
  } catch {
    // Malformed base64 or JSON in a token whose HMAC somehow validated.
    return undefined;
  }
}

export function createRefreshToken() {
  return randomBytes(48).toString("base64url");
}

