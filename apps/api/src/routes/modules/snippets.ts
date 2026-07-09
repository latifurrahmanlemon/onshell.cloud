import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Snippet } from "@onshell/shared";
import { z } from "zod";
import { getCurrentUser } from "../../lib/current-user.js";
import { handleRouteError } from "../../lib/reply.js";
import { createAudit, store } from "../../lib/store.js";

const snippetSchema = z.object({
  name: z.string().min(2),
  command: z.string().min(1),
  scope: z.enum(["personal", "team", "host"]).default("personal"),
  hostId: z.string().optional()
});

export async function registerSnippetRoutes(app: FastifyInstance) {
  app.get("/snippets", async (request) => {
    const user = getCurrentUser(request);
    return store.snippets.filter((snippet) => snippet.organizationId === user.organizationId);
  });

  app.post("/snippets", async (request, reply) => {
    try {
      const actor = getCurrentUser(request);
      const body = snippetSchema.parse(request.body);
      const now = new Date().toISOString();
      const snippet: Snippet = {
        id: `snippet_${randomUUID()}`,
        organizationId: actor.organizationId,
        ownerId: actor.id,
        name: body.name,
        command: body.command,
        scope: body.scope,
        hostId: body.hostId,
        createdAt: now,
        updatedAt: now
      };

      store.snippets.unshift(snippet);
      createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "snippet.create",
        targetType: "snippet",
        targetId: snippet.id,
        ipAddress: request.ip
      });

      return reply.code(201).send(snippet);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}

