import type { FastifyInstance } from "fastify";
import type { Role } from "@onshell/shared";
import { canOpenSession } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { accessibleHostFilter } from "../../lib/host-access.js";
import { prisma } from "../../lib/prisma.js";
import { recordAudit } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

/**
 * Ceiling on hosts per workspace. Opening a workspace opens one terminal per
 * host, and every terminal is a live gateway connection — a 200-host workspace
 * would be a single click that exhausts the session limit and the browser's
 * memory at the same time.
 */
const MAX_WORKSPACE_HOSTS = 20;

const hostIdsSchema = z
  .array(z.string().min(1))
  .min(1, "Pick at least one host.")
  .max(MAX_WORKSPACE_HOSTS, `A workspace can hold at most ${MAX_WORKSPACE_HOSTS} hosts.`);

const createSchema = z.object({
  name: z.string().trim().min(2, "Give the workspace a name of at least 2 characters.").max(80),
  description: z.string().trim().max(2000).optional(),
  hostIds: hostIdsSchema
});

/**
 * Every field is optional so the console can rename without resending the host
 * list. `description: null` clears the note; omitting it leaves it alone, which
 * is why the nullable and the optional are not interchangeable here.
 */
const patchSchema = z.object({
  name: z.string().trim().min(2, "Give the workspace a name of at least 2 characters.").max(80).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  hostIds: hostIdsSchema.optional()
});

const workspaceParamsSchema = z.object({ id: z.string().min(1) });

/**
 * Shape the console expects (see apps/web/src/app/console/api.ts). `hostIds`
 * carries only the memberships the caller may reach, so the count a member sees
 * is the count they can actually open.
 */
interface WorkspacePayload {
  id: string;
  name: string;
  description: string | null;
  hostIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** The parts of the authenticated user every host-access check needs. */
interface WorkspaceActor {
  id: string;
  role: Role;
  organizationId: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  hosts: Array<{ hostId: string }>;
}

function toWorkspace(row: WorkspaceRow): WorkspacePayload {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    hostIds: row.hosts.map((membership) => membership.hostId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export async function registerHostWorkspaceRoutes(app: FastifyInstance) {
  /**
   * Loads one workspace with its memberships already narrowed to the hosts this
   * user may reach. Doing the narrowing in the query (rather than filtering the
   * result) is what keeps a member from ever receiving an id they have no grant
   * for, on any of the four routes.
   */
  async function loadWorkspace(
    workspaceId: string,
    user: WorkspaceActor
  ) {
    const hostFilter = await accessibleHostFilter(user.id, user.role, user.organizationId);
    return prisma.hostWorkspace.findFirst({
      where: { id: workspaceId, organizationId: user.organizationId },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        hosts: {
          where: { host: hostFilter },
          orderBy: { position: "asc" },
          select: { hostId: true }
        }
      }
    });
  }

  /**
   * Keeps the requested ids the user actually holds a grant for, in the order
   * they were sent, and drops the rest silently. Refusing the whole request
   * would tell the caller that an id they cannot see nonetheless exists, so an
   * unauthorised id is treated as a typo: it simply does not get stored, and the
   * response returns the set that did.
   */
  async function retainAccessibleHostIds(
    user: WorkspaceActor,
    hostIds: string[]
  ) {
    const requested = [...new Set(hostIds)];
    const hostFilter = await accessibleHostFilter(user.id, user.role, user.organizationId);
    const allowed = await prisma.host.findMany({
      where: { ...hostFilter, id: { in: requested } },
      select: { id: true }
    });
    const allowedSet = new Set(allowed.map((host) => host.id));
    // Preserve the submitted order and repetitions: each occurrence represents
    // one terminal pane, while the unique list above is only for access lookup.
    return hostIds.filter((hostId) => allowedSet.has(hostId));
  }

  app.get("/host-workspaces", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const hostFilter = await accessibleHostFilter(user.id, user.role, user.organizationId);
      const workspaces = await prisma.hostWorkspace.findMany({
        where: { organizationId: user.organizationId },
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          updatedAt: true,
          hosts: {
            where: { host: hostFilter },
            orderBy: { position: "asc" },
            select: { hostId: true }
          }
        },
        orderBy: { name: "asc" }
      });

      return { workspaces: workspaces.map(toWorkspace) };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/host-workspaces", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      // Gated on opening sessions rather than managing hosts: a workspace only
      // groups hosts the caller can already connect to, so a developer should be
      // able to save one — while an auditor, who cannot open a terminal, has no
      // use for a shortcut that opens twenty.
      if (!canOpenSession(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = createSchema.parse(request.body);
      const hostIds = await retainAccessibleHostIds(actor, body.hostIds);
      if (hostIds.length === 0) {
        // Every requested id was dropped, so there is nothing to save. Reported
        // as a plain validation failure — it says nothing about whether those
        // ids exist, only that this caller cannot use them.
        return reply.code(400).send({
          error: "no_accessible_hosts",
          message: "None of those hosts are available to you."
        });
      }

      const workspace = await prisma.hostWorkspace.create({
        data: {
          organizationId: actor.organizationId,
          name: body.name,
          description: body.description,
          createdById: actor.id,
          hosts: {
            create: hostIds.map((hostId, index) => ({ hostId, position: index }))
          }
        },
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          updatedAt: true,
          hosts: { orderBy: { position: "asc" }, select: { hostId: true } }
        }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.workspace.create",
        targetType: "host_workspace",
        targetId: workspace.id,
        ipAddress: request.ip,
        // `requested` vs `hosts` makes a silent drop visible to whoever reads
        // the audit log later, without failing the request at the time.
        metadata: { name: workspace.name, hosts: hostIds.length, requested: body.hostIds.length }
      });

      return reply.code(201).send(toWorkspace(workspace));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/host-workspaces/:id", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canOpenSession(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { id } = workspaceParamsSchema.parse(request.params);
      const body = patchSchema.parse(request.body);
      const existing = await loadWorkspace(id, actor);
      if (!existing) {
        return reply.code(404).send({ error: "workspace_not_found" });
      }

      let hostIds: string[] | undefined;
      if (body.hostIds !== undefined) {
        hostIds = await retainAccessibleHostIds(actor, body.hostIds);
        if (hostIds.length === 0) {
          return reply.code(400).send({
            error: "no_accessible_hosts",
            message: "None of those hosts are available to you."
          });
        }
      }

      // Memberships are replaced wholesale rather than diffed: `position` is
      // derived from the incoming order, so a diff would have to renumber the
      // survivors anyway. Wrapped in a transaction so a failure halfway cannot
      // leave the workspace holding only the deleted half.
      //
      // The delete is unfiltered on purpose. A member who cannot see one of the
      // workspace's hosts still gets it removed here — that is the honest
      // reading of "these are the hosts now", and pretending otherwise would let
      // an invisible host reappear in a list the member believes they curated.
      const workspace = await prisma.$transaction(async (tx) => {
        if (hostIds) {
          await tx.hostWorkspaceHost.deleteMany({ where: { workspaceId: existing.id } });
        }
        return tx.hostWorkspace.update({
          where: { id: existing.id },
          data: {
            ...(body.name !== undefined && { name: body.name }),
            ...(body.description !== undefined && { description: body.description }),
            ...(hostIds && {
              hosts: { create: hostIds.map((hostId, index) => ({ hostId, position: index })) }
            })
          },
          select: {
            id: true,
            name: true,
            description: true,
            createdAt: true,
            updatedAt: true,
            hosts: { orderBy: { position: "asc" }, select: { hostId: true } }
          }
        });
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.workspace.update",
        targetType: "host_workspace",
        targetId: workspace.id,
        ipAddress: request.ip,
        metadata: {
          name: workspace.name,
          ...(hostIds && { hosts: hostIds.length, requested: body.hostIds?.length ?? 0 })
        }
      });

      // On a replace, every stored id is one this request just authorised, so the
      // update's own (unfiltered) select is safe to echo. On a rename the set was
      // untouched, so the access-filtered version from `loadWorkspace` is
      // returned instead — otherwise a plain rename would hand the caller ids
      // for hosts they hold no grant for.
      return toWorkspace({ ...workspace, hosts: hostIds ? workspace.hosts : existing.hosts });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/host-workspaces/:id", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canOpenSession(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { id } = workspaceParamsSchema.parse(request.params);
      const existing = await prisma.hostWorkspace.findFirst({
        where: { id, organizationId: actor.organizationId },
        select: { id: true, name: true }
      });
      if (!existing) {
        return reply.code(404).send({ error: "workspace_not_found" });
      }

      // Memberships go with it through the FK cascade; no host is touched.
      await prisma.hostWorkspace.delete({ where: { id: existing.id } });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.workspace.delete",
        targetType: "host_workspace",
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
