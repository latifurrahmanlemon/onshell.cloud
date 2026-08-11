import type { FastifyInstance } from "fastify";
import type { Host } from "@onshell/shared";
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

/**
 * How far back "most used" looks. Thirty days is long enough to survive a quiet
 * fortnight and short enough that a machine nobody has touched since the last
 * migration stops sitting at the top of the list.
 */
const USAGE_WINDOW_DAYS = 30;

/**
 * The order the console shows hosts in: what you pinned, then what the team
 * actually uses, then alphabetically so equal rows never shuffle between loads.
 *
 * Sorted here rather than in the database because "favourite" is per reader and
 * the usage count is an aggregate — expressing both in one `orderBy` would take
 * a raw query for a list that is already in memory.
 */
function byFavoriteThenUsage(a: Host, b: Host) {
  if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
  const usage = (b.sessionCount ?? 0) - (a.sessionCount ?? 0);
  if (usage !== 0) return usage;
  return a.name.localeCompare(b.name);
}

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

      const hostIds = hosts.map((host) => host.id);

      // Most recent session per host — surfaced as "last session" in the hosts table.
      const lastSessions = hosts.length
        ? await prisma.session.groupBy({
            by: ["hostId"],
            where: { organizationId: user.organizationId, hostId: { in: hostIds } },
            _max: { startedAt: true }
          })
        : [];
      const lastSessionByHost = new Map(lastSessions.map((row) => [row.hostId, row._max.startedAt]));

      // How busy each machine has been lately, and which ones this account has
      // pinned. Counted over a rolling window rather than all time so a server
      // that mattered a year ago stops crowding out the one being worked on now.
      const [usageRows, favorites] = hosts.length
        ? await Promise.all([
            prisma.session.groupBy({
              by: ["hostId"],
              where: {
                organizationId: user.organizationId,
                hostId: { in: hostIds },
                startedAt: { gte: new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000) }
              },
              _count: { _all: true }
            }),
            prisma.hostFavorite.findMany({
              where: { userId: user.id, hostId: { in: hostIds } },
              select: { hostId: true }
            })
          ])
        : [[], []];
      const sessionCountByHost = new Map(usageRows.map((row) => [row.hostId, row._count._all]));
      const favoriteHostIds = new Set(favorites.map((row) => row.hostId));

      return hosts
        .map((host) =>
          toHost(host, lastSessionByHost.get(host.id), {
            isFavorite: favoriteHostIds.has(host.id),
            sessionCount: sessionCountByHost.get(host.id) ?? 0
          })
        )
        .sort(byFavoriteThenUsage);
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

  /**
   * Pin and unpin a host for the calling account.
   *
   * Open to every role that can see the host, `viewer` included: a favourite
   * changes one person's ordering and nothing else, so gating it behind
   * `canManageHosts` would only stop the people with the longest lists from
   * organising them. Not audited for the same reason — it grants nothing.
   */
  app.put("/hosts/:hostId/favorite", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const { hostId } = z.object({ hostId: z.string() }).parse(request.params);
      const accessFilter = await accessibleHostFilter(user.id, user.role, user.organizationId);
      const host = await prisma.host.findFirst({ where: { ...accessFilter, id: hostId } });
      if (!host) return reply.code(404).send({ error: "host_not_found" });

      // Idempotent: pinning an already-pinned host is a no-op rather than a 409,
      // because the button it backs is a toggle that can be double-clicked.
      await prisma.hostFavorite.upsert({
        where: { userId_hostId: { userId: user.id, hostId: host.id } },
        create: { userId: user.id, hostId: host.id },
        update: {}
      });

      return { ok: true, isFavorite: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/hosts/:hostId/favorite", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const { hostId } = z.object({ hostId: z.string() }).parse(request.params);
      // No access check on the way out: removing a pin the account already holds
      // is always safe, and refusing it on a host whose grant was revoked would
      // leave the row stuck forever.
      await prisma.hostFavorite.deleteMany({ where: { userId: user.id, hostId } });

      return { ok: true, isFavorite: false };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
