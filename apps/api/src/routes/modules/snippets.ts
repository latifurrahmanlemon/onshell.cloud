import type { FastifyInstance } from "fastify";
import { canManageUsers, type User } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { accessibleHostFilter } from "../../lib/host-access.js";
import { prisma } from "../../lib/prisma.js";
import { recordAudit, toSnippet } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

const snippetSchema = z.object({
  name: z.string().min(2),
  command: z.string().min(1),
  scope: z.enum(["personal", "team", "host"]).default("personal"),
  hostId: z.string().optional()
});

const snippetPatchSchema = snippetSchema.partial().extend({
  hostId: z.string().nullable().optional()
});

function canEditSnippet(actor: User, snippet: { ownerId: string }) {
  return snippet.ownerId === actor.id || canManageUsers(actor.role);
}

/** A host-scoped snippet may only point at a host the actor holds a grant for. */
async function hostIsAccessible(actor: User, hostId: string) {
  const filter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);
  const host = await prisma.host.findFirst({ where: { ...filter, id: hostId }, select: { id: true } });
  return host !== null;
}

export async function registerSnippetRoutes(app: FastifyInstance) {
  app.get("/snippets", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const accessFilter = await accessibleHostFilter(user.id, user.role, user.organizationId);
      const snippets = await prisma.snippet.findMany({
        where: {
          organizationId: user.organizationId,
          AND: [
            { OR: [{ scope: { in: ["team", "host"] } }, { scope: "personal", ownerId: user.id }] },
            // A host-scoped snippet names the host it belongs to, so it stays
            // hidden unless the member holds a grant for that host.
            { OR: [{ hostId: null }, { host: accessFilter }] }
          ]
        },
        orderBy: { createdAt: "desc" }
      });

      return snippets.map(toSnippet);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/snippets", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const body = snippetSchema.parse(request.body);
      if (body.hostId && !(await hostIsAccessible(actor, body.hostId))) {
        return reply.code(404).send({ error: "host_not_found" });
      }

      const snippet = await prisma.snippet.create({
        data: {
          organizationId: actor.organizationId,
          ownerId: actor.id,
          name: body.name,
          command: body.command,
          scope: body.scope,
          hostId: body.hostId
        }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "snippet.create",
        targetType: "snippet",
        targetId: snippet.id,
        ipAddress: request.ip
      });

      return reply.code(201).send(toSnippet(snippet));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/snippets/:snippetId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const { snippetId } = z.object({ snippetId: z.string() }).parse(request.params);
      const body = snippetPatchSchema.parse(request.body);
      const existing = await prisma.snippet.findFirst({
        where: { id: snippetId, organizationId: actor.organizationId }
      });
      if (!existing) {
        return reply.code(404).send({ error: "snippet_not_found" });
      }
      if (!canEditSnippet(actor, existing)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      if (body.hostId && !(await hostIsAccessible(actor, body.hostId))) {
        return reply.code(404).send({ error: "host_not_found" });
      }

      const snippet = await prisma.snippet.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.command !== undefined && { command: body.command }),
          ...(body.scope !== undefined && { scope: body.scope }),
          ...(body.hostId !== undefined && { hostId: body.hostId })
        }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "snippet.update",
        targetType: "snippet",
        targetId: snippet.id,
        ipAddress: request.ip
      });

      return toSnippet(snippet);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/snippets/:snippetId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const { snippetId } = z.object({ snippetId: z.string() }).parse(request.params);
      const existing = await prisma.snippet.findFirst({
        where: { id: snippetId, organizationId: actor.organizationId }
      });
      if (!existing) {
        return reply.code(404).send({ error: "snippet_not_found" });
      }
      if (!canEditSnippet(actor, existing)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      await prisma.snippet.delete({ where: { id: existing.id } });
      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "snippet.delete",
        targetType: "snippet",
        targetId: existing.id,
        ipAddress: request.ip,
        metadata: { name: existing.name }
      });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
