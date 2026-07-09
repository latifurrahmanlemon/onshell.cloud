import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { canManageHosts, type Host } from "@onshell/shared";
import { z } from "zod";
import { getCurrentUser } from "../../lib/current-user.js";
import { handleRouteError } from "../../lib/reply.js";
import { createAudit, store } from "../../lib/store.js";

const hostSchema = z.object({
  name: z.string().min(2),
  type: z.enum(["ssh", "rdp", "vnc"]),
  address: z.string().min(2),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  environment: z.enum(["production", "staging", "development"]),
  tags: z.array(z.string()).default([]),
  group: z.string().optional(),
  notes: z.string().optional()
});

export async function registerHostRoutes(app: FastifyInstance) {
  app.get("/hosts", async (request) => {
    const user = getCurrentUser(request);
    const query = z
      .object({
        type: z.enum(["ssh", "rdp", "vnc"]).optional(),
        environment: z.enum(["production", "staging", "development"]).optional(),
        search: z.string().optional()
      })
      .parse(request.query);

    return store.hosts.filter((host) => {
      if (host.organizationId !== user.organizationId) return false;
      if (query.type && host.type !== query.type) return false;
      if (query.environment && host.environment !== query.environment) return false;
      if (query.search) {
        const haystack = `${host.name} ${host.address} ${host.tags.join(" ")}`.toLowerCase();
        return haystack.includes(query.search.toLowerCase());
      }

      return true;
    });
  });

  app.post("/hosts", async (request, reply) => {
    try {
      const actor = getCurrentUser(request);
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = hostSchema.parse(request.body);
      const now = new Date().toISOString();
      const host: Host = {
        id: `host_${randomUUID()}`,
        organizationId: actor.organizationId,
        health: "unknown",
        createdAt: now,
        updatedAt: now,
        ...body
      };

      store.hosts.push(host);
      createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.create",
        targetType: "host",
        targetId: host.id,
        ipAddress: request.ip,
        metadata: { type: host.type, environment: host.environment }
      });

      return reply.code(201).send(host);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/hosts/:hostId", async (request, reply) => {
    try {
      const actor = getCurrentUser(request);
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { hostId } = z.object({ hostId: z.string() }).parse(request.params);
      const body = hostSchema.partial().parse(request.body);
      const host = store.hosts.find((candidate) => candidate.id === hostId && candidate.organizationId === actor.organizationId);
      if (!host) {
        return reply.code(404).send({ error: "host_not_found" });
      }

      Object.assign(host, body, { updatedAt: new Date().toISOString() });
      createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.update",
        targetType: "host",
        targetId: host.id,
        ipAddress: request.ip
      });

      return host;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
