import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CredentialSummary } from "@onshell/shared";
import { z } from "zod";
import { getCurrentUser } from "../../lib/current-user.js";
import { handleRouteError } from "../../lib/reply.js";
import { createAudit, store } from "../../lib/store.js";

const credentialSchema = z.object({
  name: z.string().min(2),
  kind: z.enum(["password", "ssh_key", "rdp_password"]),
  secret: z.string().min(1),
  attachedHostIds: z.array(z.string()).default([])
});

export async function registerCredentialRoutes(app: FastifyInstance) {
  app.get("/credentials", async (request) => {
    const user = getCurrentUser(request);
    return store.credentials.filter((credential) => credential.organizationId === user.organizationId);
  });

  app.post("/credentials", async (request, reply) => {
    try {
      const actor = getCurrentUser(request);
      const body = credentialSchema.parse(request.body);
      const credential: CredentialSummary = {
        id: `cred_${randomUUID()}`,
        organizationId: actor.organizationId,
        name: body.name,
        kind: body.kind,
        attachedHostIds: body.attachedHostIds,
        rotatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };

      store.credentials.push(credential);
      createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "credential.create",
        targetType: "credential",
        targetId: credential.id,
        ipAddress: request.ip,
        metadata: {
          kind: credential.kind,
          attachedHostIds: credential.attachedHostIds,
          secretLength: body.secret.length
        }
      });

      return reply.code(201).send(credential);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}

