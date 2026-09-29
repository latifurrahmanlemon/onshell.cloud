import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canManagePlatform } from "@onshell/shared";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { membershipOrder } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

const DAY = 24 * 60 * 60 * 1000;

async function requirePlatformAdmin(request: FastifyRequest, config: RuntimeConfig) {
  const actor = await getAuthenticatedUser(request, config);
  return actor && canManagePlatform(actor) ? actor : undefined;
}

interface OwnerStats {
  total: number;
  firstCreatedAt?: Date;
  lastActivityAt?: Date;
  counts: Record<string, number>;
}

/** Joins per-owner aggregates to the accounts behind them, busiest first. */
async function withUsers(stats: Map<string, OwnerStats>) {
  const users = await prisma.user.findMany({
    where: { id: { in: [...stats.keys()] } },
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { ...membershipOrder, take: 1, select: { organization: { select: { name: true } } } },
      authEvents: { where: { success: true, event: { in: ["LOGIN", "TWO_FACTOR_COMPLETED"] } }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } }
    }
  });
  return users
    .map((user) => {
      const item = stats.get(user.id)!;
      return {
        userId: user.id,
        name: user.name,
        email: user.email,
        organizationName: user.memberships[0]?.organization.name ?? null,
        lastLoginAt: user.authEvents[0]?.createdAt.toISOString() ?? null,
        total: item.total,
        ...item.counts,
        firstCreatedAt: item.firstCreatedAt?.toISOString() ?? null,
        lastActivityAt: item.lastActivityAt?.toISOString() ?? null
      };
    })
    .sort((left, right) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""));
}

function stat(stats: Map<string, OwnerStats>, ownerId: string) {
  let item = stats.get(ownerId);
  if (!item) stats.set(ownerId, (item = { total: 0, counts: {} }));
  return item;
}

function later(left: Date | undefined, right: Date | null | undefined) {
  return !right ? left : !left || right > left ? right : left;
}

function earlier(left: Date | undefined, right: Date | null | undefined) {
  return !right ? left : !left || right < left ? right : left;
}

function activeSince(users: Array<{ lastActivityAt: string | null }>, days: number) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  return users.filter((user) => (user.lastActivityAt ?? "") >= since).length;
}

export async function registerAdminProductivityRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/admin/tasks/summary", async (request, reply) => {
    try {
      if (!(await requirePlatformAdmin(request, config))) return reply.code(403).send({ error: "forbidden" });
      const weekAgo = new Date(Date.now() - 7 * DAY);
      const [groups, createdThisWeek] = await Promise.all([
        prisma.taskItem.groupBy({
          by: ["ownerId", "completed"],
          _count: { _all: true },
          _min: { createdAt: true },
          _max: { updatedAt: true }
        }),
        prisma.taskItem.count({ where: { createdAt: { gte: weekAgo } } })
      ]);
      const stats = new Map<string, OwnerStats>();
      for (const group of groups) {
        const item = stat(stats, group.ownerId);
        item.total += group._count._all;
        const key = group.completed ? "completed" : "open";
        item.counts[key] = (item.counts[key] ?? 0) + group._count._all;
        item.firstCreatedAt = earlier(item.firstCreatedAt, group._min.createdAt);
        item.lastActivityAt = later(item.lastActivityAt, group._max.updatedAt);
      }
      for (const item of stats.values()) item.counts = { open: item.counts.open ?? 0, completed: item.counts.completed ?? 0 };
      const users = await withUsers(stats);
      const total = users.reduce((sum, user) => sum + user.total, 0);
      const completed = users.reduce((sum, user) => sum + (user as { completed?: number }).completed!, 0);
      return {
        totals: { users: users.length, total, open: total - completed, completed, createdThisWeek, active7d: activeSince(users, 7), active30d: activeSince(users, 30) },
        users
      };
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.get("/admin/notes/summary", async (request, reply) => {
    try {
      if (!(await requirePlatformAdmin(request, config))) return reply.code(403).send({ error: "forbidden" });
      const weekAgo = new Date(Date.now() - 7 * DAY);
      const [groups, trashed, archived, pinned, revisions, createdThisWeek] = await Promise.all([
        prisma.note.groupBy({ by: ["ownerId"], _count: { _all: true }, _min: { createdAt: true }, _max: { updatedAt: true } }),
        prisma.note.groupBy({ by: ["ownerId"], where: { trashedAt: { not: null } }, _count: { _all: true } }),
        prisma.note.groupBy({ by: ["ownerId"], where: { archived: true, trashedAt: null }, _count: { _all: true } }),
        prisma.note.groupBy({ by: ["ownerId"], where: { pinned: true, archived: false, trashedAt: null }, _count: { _all: true } }),
        prisma.noteRevision.groupBy({ by: ["actorId"], _count: { _all: true }, _max: { createdAt: true } }),
        prisma.note.count({ where: { createdAt: { gte: weekAgo } } })
      ]);
      const stats = new Map<string, OwnerStats>();
      for (const group of groups) {
        const item = stat(stats, group.ownerId);
        item.total = group._count._all;
        item.firstCreatedAt = group._min.createdAt ?? undefined;
        item.lastActivityAt = group._max.updatedAt ?? undefined;
      }
      const countOf = (rows: Array<{ ownerId: string; _count: { _all: number } }>) => new Map(rows.map((row) => [row.ownerId, row._count._all]));
      const trashedBy = countOf(trashed), archivedBy = countOf(archived), pinnedBy = countOf(pinned);
      const changesBy = new Map(revisions.map((row) => [row.actorId, row]));
      for (const [ownerId, item] of stats) {
        const changes = changesBy.get(ownerId);
        const trashedCount = trashedBy.get(ownerId) ?? 0, archivedCount = archivedBy.get(ownerId) ?? 0;
        item.counts = { active: item.total - trashedCount - archivedCount, pinned: pinnedBy.get(ownerId) ?? 0, archived: archivedCount, trashed: trashedCount, changes: changes?._count._all ?? 0 };
        item.lastActivityAt = later(item.lastActivityAt, changes?._max.createdAt);
      }
      const users = await withUsers(stats);
      const sum = (key: string) => users.reduce((total, user) => total + ((user as unknown as Record<string, number>)[key] ?? 0), 0);
      return {
        totals: { users: users.length, total: sum("total"), active: sum("active"), pinned: sum("pinned"), archived: sum("archived"), trashed: sum("trashed"), changes: sum("changes"), createdThisWeek, active7d: activeSince(users, 7), active30d: activeSince(users, 30) },
        users
      };
    } catch (error) { return handleRouteError(reply, error); }
  });
}
