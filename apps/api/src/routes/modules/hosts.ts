import type { FastifyInstance } from "fastify";
import { canManageHosts } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { accessibleHostFilter, hasImplicitHostAccess } from "../../lib/host-access.js";
import { prisma } from "../../lib/prisma.js";
import {
  environmentToPrisma,
  hostTypeToPrisma,
  recordAudit,
  toHost
} from "../../lib/prisma-mappers.js";
import { canUseLocalShell, ensureLocalHost } from "../../lib/provisioning.js";
import { handleRouteError } from "../../lib/reply.js";

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

const hostPatchSchema = hostSchema.partial().extend({
  group: z.string().nullable().optional()
});

const hostQuerySchema = z.object({
  type: z.enum(["ssh", "rdp", "vnc"]).optional(),
  environment: z.enum(["production", "staging", "development"]).optional(),
  search: z.string().optional(),
  group: z.string().optional(),
  tag: z.string().optional()
});

const hostInclude = { tags: true, group: true } as const;

async function resolveGroupId(organizationId: string, name: string) {
  const existing = await prisma.hostGroup.findFirst({ where: { organizationId, name } });
  if (existing) return existing.id;

  const created = await prisma.hostGroup.create({ data: { organizationId, name } });
  return created.id;
}

export async function registerHostRoutes(app: FastifyInstance) {
  app.get("/hosts", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const query = hostQuerySchema.parse(request.query);
      // Creates the gateway-local host for the one account allowed to have one,
      // and is a no-op for everybody else.
      await ensureLocalHost(user);
      const accessFilter = await accessibleHostFilter(user.id, user.role, user.organizationId);
      const hosts = await prisma.host.findMany({
        where: {
          ...accessFilter,
          // Rows created while this was an env flag stay in the database but
          // drop out of every other account's console, so no cleanup migration
          // is needed for the workspaces that were handed one by mistake.
          ...(canUseLocalShell(user) ? {} : { isLocal: false }),
          ...(query.type && { type: hostTypeToPrisma[query.type] }),
          ...(query.environment && { environment: environmentToPrisma[query.environment] }),
          ...(query.group && { group: { name: query.group } }),
          ...(query.tag && { tags: { some: { name: query.tag } } }),
          ...(query.search && {
            OR: [
              { name: { contains: query.search } },
              { address: { contains: query.search } },
              { tags: { some: { name: { contains: query.search } } } }
            ]
          })
        },
        include: hostInclude,
        orderBy: { createdAt: "desc" }
      });

      // Most recent session per host — surfaced as "last session" in the hosts table.
      const lastSessions = hosts.length
        ? await prisma.session.groupBy({
            by: ["hostId"],
            where: { organizationId: user.organizationId, hostId: { in: hosts.map((host) => host.id) } },
            _max: { startedAt: true }
          })
        : [];
      const lastSessionByHost = new Map(lastSessions.map((row) => [row.hostId, row._max.startedAt]));

      return hosts.map((host) => toHost(host, lastSessionByHost.get(host.id)));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/hosts", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = hostSchema.parse(request.body);
      const groupId = body.group ? await resolveGroupId(actor.organizationId, body.group) : undefined;
      const host = await prisma.host.create({
        data: {
          organizationId: actor.organizationId,
          name: body.name,
          type: hostTypeToPrisma[body.type],
          address: body.address,
          port: body.port,
          username: body.username,
          environment: environmentToPrisma[body.environment],
          notes: body.notes,
          groupId,
          tags: { create: body.tags.map((name) => ({ name })) }
        },
        include: hostInclude
      });

      // A devops member may add hosts but is still governed by grants, so give
      // them one for what they just created — otherwise the new host vanishes
      // from their own list the moment it is saved.
      if (!hasImplicitHostAccess(actor.role)) {
        await prisma.hostAccessGrant.create({
          data: {
            organizationId: actor.organizationId,
            userId: actor.id,
            hostId: host.id,
            scopeKey: host.id,
            grantedById: actor.id
          }
        });
      }

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.create",
        targetType: "host",
        targetId: host.id,
        ipAddress: request.ip,
        metadata: { type: body.type, environment: body.environment }
      });

      return reply.code(201).send(toHost(host));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/hosts/:hostId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { hostId } = z.object({ hostId: z.string() }).parse(request.params);
      const body = hostPatchSchema.parse(request.body);
      // 404 rather than 403: a member without a grant should not learn that the
      // host exists at all.
      const accessFilter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);
      const existing = await prisma.host.findFirst({
        where: { ...accessFilter, id: hostId }
      });
      if (!existing) {
        return reply.code(404).send({ error: "host_not_found" });
      }
      if (existing.isLocal) {
        // Its address and port are display-only — editing them would suggest the
        // local shell can be pointed somewhere it cannot go.
        return reply.code(400).send({
          error: "local_host_immutable",
          message: "The built-in local host cannot be edited."
        });
      }

      const groupId =
        body.group === undefined
          ? undefined
          : !body.group
            ? null
            : await resolveGroupId(actor.organizationId, body.group);
      const host = await prisma.host.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.type !== undefined && { type: hostTypeToPrisma[body.type] }),
          ...(body.address !== undefined && { address: body.address }),
          ...(body.port !== undefined && { port: body.port }),
          ...(body.username !== undefined && { username: body.username }),
          ...(body.environment !== undefined && { environment: environmentToPrisma[body.environment] }),
          ...(body.notes !== undefined && { notes: body.notes }),
          ...(groupId !== undefined && { groupId }),
          ...(body.tags !== undefined && {
            tags: { deleteMany: {}, create: body.tags.map((name) => ({ name })) }
          })
        },
        include: hostInclude
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.update",
        targetType: "host",
        targetId: host.id,
        ipAddress: request.ip
      });

      return toHost(host);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/hosts/:hostId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { hostId } = z.object({ hostId: z.string() }).parse(request.params);
      const accessFilter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);
      const existing = await prisma.host.findFirst({
        where: { ...accessFilter, id: hostId }
      });
      if (!existing) {
        return reply.code(404).send({ error: "host_not_found" });
      }
      if (existing.isLocal) {
        // Deleting it would only make the console re-create it on the next list.
        return reply.code(400).send({
          error: "local_host_immutable",
          message: "The built-in local host cannot be removed."
        });
      }

      await prisma.$transaction([
        prisma.snippet.updateMany({ where: { hostId: existing.id }, data: { hostId: null } }),
        prisma.host.delete({ where: { id: existing.id } })
      ]);

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.delete",
        targetType: "host",
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
