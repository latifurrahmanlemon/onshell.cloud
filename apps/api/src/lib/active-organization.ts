/**
 * Which of a person's workspaces a request is looking at.
 *
 * Kept free of Prisma, next to refresh-token-policy.ts, so the rule can be read
 * and tested on its own — it decides what a whole session sees, and that is not
 * a thing to leave implicit in a route handler.
 *
 * The failure it exists to stop: `user.memberships[0]` looked arbitrary and was
 * not. A user loaded through the userId index comes back in primary-key order,
 * and the key is a time-prefixed cuid, so the first membership was always the
 * *oldest* one. Someone who accepted an invitation to a second workspace was
 * pinned to their first workspace permanently — granted a host they could never
 * see, with nothing on screen to suggest another workspace existed.
 *
 * The stored organization is a *preference*, never an authorization. Callers
 * re-read the live memberships and resolve against them on every request, which
 * is what keeps removing a member effective on their very next call rather than
 * whenever their access token happens to expire.
 */

export interface MembershipLike {
  organizationId: string;
}

/**
 * The workspace to land in when a session names none, or names one the person
 * is no longer a member of.
 *
 * Deliberately the first of a `createdAt`-ordered list — the workspace they have
 * held longest, which for almost everyone is their own — rather than "whatever
 * the query returned". Every membership load in the API now carries that
 * ordering, so this is a decision rather than a side effect of the query plan.
 */
export function fallbackMembership<T extends MembershipLike>(memberships: readonly T[]): T | undefined {
  return memberships[0];
}

export interface ResolvedMembership<T> {
  membership: T | undefined;
  /**
   * True when a workspace was asked for and the person is not in it.
   *
   * Worth reporting rather than swallowing: a member removed from the workspace
   * they were reading is otherwise teleported into another one in silence, which
   * presents as their hosts vanishing and a stranger's appearing. Cross-tenant
   * access is not the risk — the fallback is a workspace they really are in —
   * the risk is that nobody can tell what happened.
   */
  fellBack: boolean;
}

/**
 * Resolves the preferred workspace against the memberships the person actually
 * has right now.
 */
export function resolveActiveMembership<T extends MembershipLike>(
  memberships: readonly T[],
  preferred: string | null | undefined
): ResolvedMembership<T> {
  const exact = preferred ? memberships.find((member) => member.organizationId === preferred) : undefined;
  if (exact) return { membership: exact, fellBack: false };

  const membership = fallbackMembership(memberships);
  // Only a *named* workspace that could not be honoured is a fall-back worth
  // reporting. A session that named none — one minted before the column
  // existed, or a fresh sign-in — is simply taking the default.
  return { membership, fellBack: Boolean(preferred) && membership !== undefined };
}
