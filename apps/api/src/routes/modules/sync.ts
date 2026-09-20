import type { FastifyInstance } from "fastify";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";

/** A shared database counter works across API workers and server restarts. */
export async function registerSyncRoutes(app: FastifyInstance) {
  const organizations = new WeakMap<object, string>();
  app.addHook("preHandler", async (request) => {
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) return;
    if (!/^\/(hosts|credentials|snippets|tasks|host-workspaces|workspaces|organizations?|members|invitations|agents|notifications|profile|sessions|desktop\/devices|desktop\/sessions|desktop\/leases)(\/|\?|$)/.test(request.url)) return;
    const actor = await getAuthenticatedUser(request);
    if (actor) organizations.set(request, actor.organizationId);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const organizationId = organizations.get(request);
    if (organizationId && reply.statusCode >= 200 && reply.statusCode < 300) {
      try {
        await prisma.organization.update({ where: { id: organizationId }, data: { syncRevision: { increment: 1 } } });
      } catch (error) { request.log.error({ err: error }, "Could not publish workspace change"); }
    }
    return payload;
  });
  app.get("/sync", async (request, reply) => {
    const actor = await getAuthenticatedUser(request);
    if (!actor) return reply.code(401).send({ error: "unauthorized" });
    const organization = await prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { syncRevision: true } });
    reply.header("Cache-Control", "no-store");
    return { revision: `${actor.organizationId}:${organization?.syncRevision ?? 0}` };
  });
}
