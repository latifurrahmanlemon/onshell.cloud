import type { FastifyRequest } from "fastify";
import { loadConfig, type RuntimeConfig } from "@onshell/config";
import type { User } from "@onshell/shared";
import { resolveActiveMembership } from "./active-organization.js";
import { prisma } from "./prisma.js";
import { membershipOrder, toPublicUser } from "./prisma-mappers.js";
import { verifyAccessToken } from "./token.js";

const defaultConfig = loadConfig("api");

function getBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

function getAccessToken(request: FastifyRequest) {
  return getBearerToken(request) ?? request.cookies?.access_token;
}

/**
 * What the JWT asked for, and what the database was willing to give.
 *
 * The two come apart in exactly one situation, and it is the one worth naming:
 * the caller holds a live token for a workspace they have since been removed
 * from. They get the fallback workspace, which is one they really are in — no
 * cross-tenant access — but a caller told nothing about the substitution sees
 * their hosts replaced by someone else's for no visible reason.
 */
export interface AuthenticatedSession {
  user: User;
  /** The workspace the token named, when it is not the one that was resolved. */
  revokedOrganizationId?: string;
}

/**
 * Verifies the access-token JWT (Authorization bearer header or access_token
 * cookie) and loads the user plus their organization membership from Prisma.
 * Returns null for unauthenticated requests or users without a membership.
 *
 * The token's `organizationId` and `role` claims are read as a *request*, never
 * as a fact. The memberships are re-loaded here on every call and the role is
 * re-derived from the one that resolved, which is what makes revoking a member
 * take effect on their very next request instead of whenever their token
 * happens to expire — and what stops a workspace switch from widening the reach
 * of an older, still-valid token.
 */
export async function getAuthenticatedSession(
  request: FastifyRequest,
  config: RuntimeConfig = defaultConfig
): Promise<AuthenticatedSession | null> {
  const token = getAccessToken(request);
  if (!token) return null;

  const payload = verifyAccessToken(token, config.jwtSecret);
  if (!payload) return null;

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { memberships: membershipOrder }
  });
  if (!user || user.memberships.length === 0) return null;

  const active = resolveActiveMembership(user.memberships, payload.organizationId);
  return {
    user: toPublicUser(user, active.membership?.organizationId ?? null),
    ...(active.fellBack ? { revokedOrganizationId: payload.organizationId } : {})
  };
}

/** The common case: the caller only needs to know who is asking. */
export async function getAuthenticatedUser(
  request: FastifyRequest,
  config: RuntimeConfig = defaultConfig
): Promise<User | null> {
  return (await getAuthenticatedSession(request, config))?.user ?? null;
}
