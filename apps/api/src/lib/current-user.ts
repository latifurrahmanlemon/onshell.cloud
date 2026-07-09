import type { FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { store } from "./store.js";
import { prisma } from "./prisma.js";
import { toPublicUser } from "./prisma-mappers.js";
import { verifyAccessToken } from "./token.js";

export function getCurrentUser(request: FastifyRequest) {
  const email = request.headers["x-user-email"];
  if (typeof email === "string") {
    const user = store.users.find((candidate) => candidate.email === email);
    if (user) return user;
  }

  return store.users[0];
}

function getBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

export async function getAuthenticatedUser(request: FastifyRequest, config: RuntimeConfig) {
  const token = getBearerToken(request) ?? request.cookies?.access_token;
  if (token) {
    const payload = verifyAccessToken(token, config.jwtSecret);
    if (payload) {
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        include: { memberships: true }
      });
      if (user) return toPublicUser(user);
    }
  }

  const email = request.headers["x-user-email"];
  if (typeof email === "string") {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: true }
    });
    if (user) return toPublicUser(user);
  }

  return undefined;
}
