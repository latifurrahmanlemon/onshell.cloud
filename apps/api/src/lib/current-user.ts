import type { FastifyRequest } from "fastify";
import { loadConfig, type RuntimeConfig } from "@onshell/config";
import type { User } from "@onshell/shared";
import { prisma } from "./prisma.js";
import { toPublicUser } from "./prisma-mappers.js";
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
 * Verifies the access-token JWT (Authorization bearer header or access_token
 * cookie) and loads the user plus their organization membership from Prisma.
 * Returns null for unauthenticated requests or users without a membership.
 */
export async function getAuthenticatedUser(
  request: FastifyRequest,
  config: RuntimeConfig = defaultConfig
): Promise<User | null> {
  const token = getAccessToken(request);
  if (!token) return null;

  const payload = verifyAccessToken(token, config.jwtSecret);
  if (!payload) return null;

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { memberships: true }
  });
  if (!user || user.memberships.length === 0) return null;

  const memberships = [...user.memberships].sort(
    (a, b) =>
      Number(b.organizationId === payload.organizationId) -
      Number(a.organizationId === payload.organizationId)
  );

  return toPublicUser({ ...user, memberships });
}
