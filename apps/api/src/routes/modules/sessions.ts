import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canOpenSession } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { decryptSecret } from "../../lib/encryption.js";
import { prisma } from "../../lib/prisma.js";
import {
  recordAudit,
  sessionProtocolFromPrisma,
  sessionProtocolToPrisma,
  toRemoteSession
} from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

const openSessionSchema = z.object({
  hostId: z.string(),
  protocol: z.enum(["ssh", "sftp", "rdp"]).default("ssh"),
  credentialId: z.string().optional()
});

const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

interface GatewayOpenResponse {
  session: { id: string; status: string; websocketPath?: string };
  connectUrl: string;
  websocketUrl?: string;
}

function gatewayHeaders() {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sharedSecret = process.env.GATEWAY_SHARED_SECRET;
  if (sharedSecret) headers.authorization = `Bearer ${sharedSecret}`;
  return headers;
}

function toWebsocketUrl(gatewayBaseUrl: string, path: string) {
  return `${gatewayBaseUrl.replace(/^http/, "ws")}${path}`;
}

export async function registerSessionRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/sessions", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const query = listSessionsQuerySchema.parse(request.query);
      const sessions = await prisma.session.findMany({
        where: { organizationId: user.organizationId },
        orderBy: { startedAt: "desc" },
        take: query.limit
      });

      return sessions.map(toRemoteSession);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/sessions", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canOpenSession(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = openSessionSchema.parse(request.body);
      const host = await prisma.host.findFirst({
        where: { id: body.hostId, organizationId: actor.organizationId },
        include: { credentials: { orderBy: { createdAt: "asc" }, take: 1 } }
      });
      if (!host) {
        return reply.code(404).send({ error: "host_not_found" });
      }

      const credential = body.credentialId
        ? await prisma.credential.findFirst({
            where: { id: body.credentialId, organizationId: actor.organizationId }
          })
        : host.credentials[0];
      if (!credential) {
        return body.credentialId
          ? reply.code(404).send({ error: "credential_not_found" })
          : reply.code(400).send({ error: "no_credential_for_host" });
      }

      // Record when this credential was last used to open a session (best-effort).
      void prisma.credential
        .update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);

      const subscription = await prisma.subscription.findFirst({
        where: {
          organizationId: actor.organizationId,
          status: { in: ["ACTIVE", "TRIALING"] }
        },
        include: { plan: true },
        orderBy: { createdAt: "desc" }
      });
      const maxConcurrentSessions = subscription?.plan.maxConcurrentSessions;
      if (maxConcurrentSessions != null) {
        const activeSessions = await prisma.session.count({
          where: {
            organizationId: actor.organizationId,
            status: { in: ["PENDING", "ACTIVE"] }
          }
        });
        if (activeSessions >= maxConcurrentSessions) {
          return reply.code(403).send({
            error: "concurrent_session_limit_reached",
            limit: maxConcurrentSessions
          });
        }
      }

      const secret = decryptSecret(
        {
          encryptedPayload: credential.encryptedPayload,
          nonce: credential.nonce,
          authTag: credential.authTag
        },
        config.masterEncryptionKey
      );
      const gatewayBody = {
        protocol: body.protocol,
        hostId: host.id,
        address: host.address,
        port: host.port,
        username: host.username ?? undefined,
        ...(credential.kind === "SSH_KEY" ? { privateKey: secret } : { password: secret })
      };

      let gateway: GatewayOpenResponse;
      try {
        const response = await fetch(`${config.gatewayBaseUrl}/sessions`, {
          method: "POST",
          headers: gatewayHeaders(),
          body: JSON.stringify(gatewayBody)
        });
        if (!response.ok) {
          throw new Error(`gateway responded with status ${response.status}`);
        }
        gateway = (await response.json()) as GatewayOpenResponse;
      } catch (gatewayError) {
        request.log.error({ err: gatewayError }, "gateway session handoff failed");
        const failed = await prisma.session.create({
          data: {
            organizationId: actor.organizationId,
            hostId: host.id,
            userId: actor.id,
            protocol: sessionProtocolToPrisma[body.protocol],
            status: "FAILED",
            endedAt: new Date()
          }
        });
        await recordAudit({
          organizationId: actor.organizationId,
          actorId: actor.id,
          action: `${body.protocol}.session.failed`,
          targetType: "host",
          targetId: host.id,
          ipAddress: request.ip,
          metadata: { sessionId: failed.id, reason: "gateway_unreachable" }
        });

        return reply.code(502).send({
          error: "gateway_unreachable",
          message: "The session gateway could not be reached. Please try again shortly."
        });
      }

      const session = await prisma.session.create({
        data: {
          organizationId: actor.organizationId,
          hostId: host.id,
          userId: actor.id,
          protocol: sessionProtocolToPrisma[body.protocol],
          status: "ACTIVE",
          gatewaySessionId: gateway.session.id
        }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: `${body.protocol}.session.open`,
        targetType: "host",
        targetId: host.id,
        ipAddress: request.ip,
        metadata: {
          sessionId: session.id,
          gatewaySessionId: gateway.session.id,
          credentialId: credential.id
        }
      });

      const websocketUrl =
        body.protocol === "sftp"
          ? null
          : toWebsocketUrl(config.gatewayBaseUrl, `/ws/${body.protocol}/${gateway.session.id}`);

      return reply.code(201).send({
        session: toRemoteSession(session),
        websocketUrl
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/sessions/:sessionId/close", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
      const session = await prisma.session.findFirst({
        where: { id: sessionId, organizationId: actor.organizationId }
      });
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (session.gatewaySessionId) {
        try {
          await fetch(`${config.gatewayBaseUrl}/sessions/${session.gatewaySessionId}/close`, {
            method: "POST",
            headers: gatewayHeaders()
          });
        } catch (gatewayError) {
          request.log.warn({ err: gatewayError }, "gateway session close failed");
        }
      }

      const updated = await prisma.session.update({
        where: { id: session.id },
        data: { status: "CLOSED", endedAt: new Date() }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: `${sessionProtocolFromPrisma[session.protocol]}.session.close`,
        targetType: "session",
        targetId: session.id,
        ipAddress: request.ip
      });

      return toRemoteSession(updated);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
