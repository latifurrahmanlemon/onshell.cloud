/**
 * When a stored refresh token may still be traded for a session. Kept free of
 * Prisma so the rule can be read — and tested — on its own.
 */

/**
 * How long a just-rotated refresh token keeps working.
 *
 * Rotation revokes the old token the moment a new one is issued, which is right
 * for replay detection but wrong for a browser with several console tabs open:
 * they refresh independently, and the loser of the race would be signed out
 * holding a token that was valid a heartbeat ago. Inside this window the old
 * token is accepted once more instead.
 */
export const REFRESH_ROTATION_GRACE_MS = 60 * 1000;

/**
 * Unrevoked and unexpired is the ordinary case; a token revoked seconds ago is
 * also accepted, which is the rotation grace above. The expiry check comes
 * first and is what keeps a deliberate sign-out final, because
 * `revokeRefreshTokens` expires the row at the same moment it revokes it.
 */
export function isRefreshTokenUsable<T extends { revokedAt: Date | null; expiresAt: Date }>(
  token: T | null | undefined,
  now = new Date()
): token is T {
  if (!token) return false;
  if (token.expiresAt.getTime() <= now.getTime()) return false;
  if (!token.revokedAt) return true;
  return now.getTime() - token.revokedAt.getTime() < REFRESH_ROTATION_GRACE_MS;
}
