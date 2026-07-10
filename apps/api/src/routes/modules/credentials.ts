import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@onshell/config";
import { canManageHosts } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { encryptSecret } from "../../lib/encryption.js";
import { prisma } from "../../lib/prisma.js";
import {
  credentialKindFromPrisma,
  credentialKindToPrisma,
  recordAudit,
  toCredentialSummary
} from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

const config = loadConfig("api");

const createCredentialSchema = z.object({
  name: z.string().min(2),
  kind: z.enum(["password", "ssh_key", "rdp_password"]),
  secret: z.string().min(1),
  attachedHostIds: z.array(z.string()).default([])
});

const updateCredentialSchema = z.object({
  name: z.string().min(2).optional(),
  attachedHostIds: z.array(z.string()).optional()
});

const rotateCredentialSchema = z.object({
  secret: z.string().min(1)
});

const credentialInclude = { hosts: { select: { id: true } } } as const;

function sshKeyFingerprint(secret: string) {
  return `SHA256:${createHash("sha256").update(secret.trim()).digest("hex")}`;
}

async function hostsBelongToOrganization(organizationId: string, hostIds: string[]) {
  if (hostIds.length === 0) return true;
  const count = await prisma.host.count({ where: { organizationId, id: { in: hostIds } } });
  return count === hostIds.length;
}

export async function registerCredentialRoutes(app: FastifyInstance) {
  app.get("/credentials", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const credentials = await prisma.credential.findMany({
        where: { organizationId: user.organizationId },
        include: credentialInclude,
        orderBy: { createdAt: "desc" }
      });

      return credentials.map(toCredentialSummary);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/credentials", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = createCredentialSchema.parse(request.body);
      if (!(await hostsBelongToOrganization(actor.organizationId, body.attachedHostIds))) {
        return reply.code(400).send({ error: "invalid_host_ids" });
      }

      const encrypted = encryptSecret(body.secret, config.masterEncryptionKey);
      const credential = await prisma.credential.create({
        data: {
          organizationId: actor.organizationId,
          name: body.name,
          kind: credentialKindToPrisma[body.kind],
          encryptedPayload: encrypted.encryptedPayload,
          nonce: encrypted.nonce,
          authTag: encrypted.authTag,
          hosts: { connect: body.attachedHostIds.map((id) => ({ id })) },
          ...(body.kind === "ssh_key" && {
            sshKey: { create: { fingerprint: sshKeyFingerprint(body.secret) } }
          })
        },
        include: credentialInclude
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "credential.create",
        targetType: "credential",
        targetId: credential.id,
        ipAddress: request.ip,
        metadata: { kind: body.kind, attachedHostIds: body.attachedHostIds }
      });

      return reply.code(201).send(toCredentialSummary(credential));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/credentials/:credentialId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { credentialId } = z.object({ credentialId: z.string() }).parse(request.params);
      const body = updateCredentialSchema.parse(request.body);
      const existing = await prisma.credential.findFirst({
        where: { id: credentialId, organizationId: actor.organizationId }
      });
      if (!existing) {
        return reply.code(404).send({ error: "credential_not_found" });
      }

      if (body.attachedHostIds && !(await hostsBelongToOrganization(actor.organizationId, body.attachedHostIds))) {
        return reply.code(400).send({ error: "invalid_host_ids" });
      }

      const credential = await prisma.credential.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.attachedHostIds !== undefined && {
            hosts: { set: body.attachedHostIds.map((id) => ({ id })) }
          })
        },
        include: credentialInclude
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "credential.update",
        targetType: "credential",
        targetId: credential.id,
        ipAddress: request.ip,
        metadata: {
          renamed: body.name !== undefined,
          attachedHostIds: body.attachedHostIds
        }
      });

      return toCredentialSummary(credential);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/credentials/:credentialId/rotate", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { credentialId } = z.object({ credentialId: z.string() }).parse(request.params);
      const body = rotateCredentialSchema.parse(request.body);
      const existing = await prisma.credential.findFirst({
        where: { id: credentialId, organizationId: actor.organizationId }
      });
      if (!existing) {
        return reply.code(404).send({ error: "credential_not_found" });
      }

      const encrypted = encryptSecret(body.secret, config.masterEncryptionKey);
      const fingerprint = sshKeyFingerprint(body.secret);
      const credential = await prisma.credential.update({
        where: { id: existing.id },
        data: {
          encryptedPayload: encrypted.encryptedPayload,
          nonce: encrypted.nonce,
          authTag: encrypted.authTag,
          rotatedAt: new Date(),
          ...(existing.kind === "SSH_KEY" && {
            sshKey: {
              upsert: {
                update: { fingerprint },
                create: { fingerprint }
              }
            }
          })
        },
        include: credentialInclude
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "credential.rotate",
        targetType: "credential",
        targetId: credential.id,
        ipAddress: request.ip,
        metadata: { kind: credentialKindFromPrisma[existing.kind] }
      });

      return toCredentialSummary(credential);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/credentials/:credentialId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { credentialId } = z.object({ credentialId: z.string() }).parse(request.params);
      const existing = await prisma.credential.findFirst({
        where: { id: credentialId, organizationId: actor.organizationId }
      });
      if (!existing) {
        return reply.code(404).send({ error: "credential_not_found" });
      }

      await prisma.credential.delete({ where: { id: existing.id } });
      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "credential.delete",
        targetType: "credential",
        targetId: existing.id,
        ipAddress: request.ip,
        metadata: { kind: credentialKindFromPrisma[existing.kind], name: existing.name }
      });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
