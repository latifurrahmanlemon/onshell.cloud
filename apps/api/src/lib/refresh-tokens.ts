import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { REFRESH_ROTATION_GRACE_MS } from "./refresh-token-policy.js";

/**
 * Marks refresh tokens as gone for good — sign-out, password change, admin or
 * owner revocation. The expiry is pulled back as well as the revocation stamp
 * set, because the {@link REFRESH_ROTATION_GRACE_MS} window forgives a *recent*
 * revocation and must not resurrect a session someone deliberately ended.
 *
 * Returns a PrismaPromise, so it composes inside `prisma.$transaction([...])`.
 */
export function revokeRefreshTokens(where: Prisma.RefreshTokenWhereInput) {
  const now = new Date();
  return prisma.refreshToken.updateMany({
    where: { ...where, revokedAt: null },
    data: { revokedAt: now, expiresAt: now }
  });
}
