import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canOpenSession, type RemoteSession, type SessionProtocol } from "@onshell/shared";
import { z } from "zod";
import { getCurrentUser } from "../../lib/current-user.js";
import { handleRouteError } from "../../lib/reply.js";
import { createAudit, store } from "../../lib/store.js";

const openSessionSchema = z.object({
  hostId: z.string(),
  credentialId: z.string().optional(),
  protocol: z.enum(["ssh", "sftp", "rdp", "vnc", "tunnel"]).default("ssh")
});

export async function registerSessionRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/sessions", async (request) => {
    const user = getCurrentUser(request);
    return store.sessions.filter((session) => session.organizationId === user.organizationId);
  });

  app.post("/sessions", async (request, reply) => {
    try {
      const actor = getCurrentUser(request);
      if (!canOpenSession(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = openSessionSchema.parse(request.body);
      const host = store.hosts.find((candidate) => candidate.id === body.hostId && candidate.organizationId === actor.organizationId);
      if (!host) {
        return reply.code(404).send({ error: "host_not_found" });
      }

      const protocol = body.protocol as SessionProtocol;
      const gatewaySessionId = `gw_${randomUUID()}`;
      const session: RemoteSession = {
        id: `session_${randomUUID()}`,
        organizationId: actor.organizationId,
        hostId: host.id,
        userId: actor.id,
        protocol,
        status: "pending",
        startedAt: new Date().toISOString(),
        gatewaySessionId
      };

      store.sessions.unshift(session);
      createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: `${protocol}.session.open`,
        targetType: "host",
        targetId: host.id,
        ipAddress: request.ip,
        metadata: {
          sessionId: session.id,
          gatewaySessionId,
          credentialId: body.credentialId
        }
      });

      return reply.code(201).send({
        session,
        gateway: {
          sessionId: gatewaySessionId,
          connectUrl: `${config.gatewayBaseUrl}/sessions/${gatewaySessionId}`
        }
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/sessions/:sessionId/close", async (request, reply) => {
    const actor = getCurrentUser(request);
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    const session = store.sessions.find((candidate) => candidate.id === sessionId && candidate.organizationId === actor.organizationId);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    session.status = "closed";
    session.endedAt = new Date().toISOString();
    createAudit({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: `${session.protocol}.session.close`,
      targetType: "session",
      targetId: session.id,
      ipAddress: request.ip
    });

    return session;
  });
}

