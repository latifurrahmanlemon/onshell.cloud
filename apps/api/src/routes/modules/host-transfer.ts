import type { FastifyInstance } from "fastify";
import { canManageHosts } from "@onshell/shared";
import type { Environment, HostType } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { exportFormats, exportHosts } from "../../lib/host-export.js";
import { accessibleHostFilter, hasImplicitHostAccess } from "../../lib/host-access.js";
import {
  hostKey,
  importFormats,
  MAX_IMPORT_HOSTS,
  parseHostSource,
  UnknownFormatError,
  type ImportFormat,
  type ParsedHost
} from "../../lib/host-import/index.js";
import { prisma } from "../../lib/prisma.js";
import {
  environmentToPrisma,
  hostTypeToPrisma,
  recordAudit,
  toHost
} from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

/**
 * Import payloads are text, and 5,000 SSH config entries is roughly 500KB — but
 * an RDCMan estate export with long descriptions can be several megabytes, so
 * these two routes get a larger body limit than the 2MB global default.
 */
const IMPORT_BODY_LIMIT = 12 * 1024 * 1024;

/** Rows written per transaction. Keeps any single statement batch bounded. */
const INSERT_CHUNK = 50;

const environmentEnum = z.enum(["production", "staging", "development"]);

const previewSchema = z.object({
  /** Raw file contents, or pasted text. */
  content: z.string().min(1).max(IMPORT_BODY_LIMIT),
  filename: z.string().max(255).optional(),
  format: z.enum(importFormats).optional()
});

const applySchema = previewSchema.extend({
  /** Applies to every imported host, overriding what was inferred per row. */
  environmentOverride: environmentEnum.optional(),
  /** Assigns every imported host to this group, overriding the source's. */
  groupOverride: z.string().trim().max(120).optional(),
  /** Added to every imported host on top of its own tags. */
  extraTags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  /**
   * What to do when a host with the same address+port+username already exists.
   * `skip` is the default because an import should not quietly rewrite hosts the
   * team has already curated.
   */
  onDuplicate: z.enum(["skip", "update"]).default("skip")
});

const exportQuerySchema = z.object({
  format: z.enum(exportFormats).default("json"),
  environment: environmentEnum.optional(),
  type: z.enum(["ssh", "rdp", "vnc"]).optional(),
  group: z.string().max(120).optional()
});

type Disposition = "new" | "duplicate-in-file" | "exists";

interface PreviewRow extends ParsedHost {
  disposition: Disposition;
  /** Id of the matching existing host, when disposition is "exists". */
  existingHostId?: string;
}

/**
 * Classifies each parsed host against the rest of the file and against what the
 * organization already has, so the operator sees the outcome before committing.
 */
async function buildPreview(organizationId: string, parsed: ParsedHost[]) {
  const existing = await prisma.host.findMany({
    where: { organizationId },
    select: { id: true, address: true, port: true, username: true }
  });
  const existingByKey = new Map(existing.map((host) => [hostKey(host), host.id]));

  const seenInFile = new Set<string>();
  const rows: PreviewRow[] = [];

  for (const host of parsed) {
    const key = hostKey(host);

    if (seenInFile.has(key)) {
      rows.push({ ...host, disposition: "duplicate-in-file" });
      continue;
    }
    seenInFile.add(key);

    const existingId = existingByKey.get(key);
    rows.push(
      existingId ? { ...host, disposition: "exists", existingHostId: existingId } : { ...host, disposition: "new" }
    );
  }

  return { rows, existingCount: existing.length };
}

/** Resolves group names to ids, creating any that are missing. */
async function resolveGroupIds(organizationId: string, names: Iterable<string>) {
  const unique = [...new Set([...names].map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return new Map<string, string>();

  const existing = await prisma.hostGroup.findMany({
    where: { organizationId, name: { in: unique } },
    select: { id: true, name: true }
  });
  const byName = new Map(existing.map((group) => [group.name, group.id]));

  for (const name of unique) {
    if (byName.has(name)) continue;
    const created = await prisma.hostGroup.create({ data: { organizationId, name } });
    byName.set(name, created.id);
  }

  return byName;
}

export async function registerHostTransferRoutes(app: FastifyInstance) {
  /**
   * Dry run: parses the file and reports exactly what an import would do, without
   * writing anything. The UI always calls this before /hosts/import.
   */
  app.post(
    "/hosts/import/preview",
    { bodyLimit: IMPORT_BODY_LIMIT, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const actor = await getAuthenticatedUser(request);
        if (!actor) return reply.code(401).send({ error: "unauthorized" });
        if (!canManageHosts(actor.role)) return reply.code(403).send({ error: "forbidden" });

        const body = previewSchema.parse(request.body);

        let parsed;
        try {
          parsed = parseHostSource({ text: body.content, filename: body.filename, format: body.format });
        } catch (error) {
          if (error instanceof UnknownFormatError) {
            return reply.code(422).send({
              error: "unrecognised_format",
              message:
                "Could not recognise this file. Supported: Onshell JSON, Termius JSON/CSV, OpenSSH config, PuTTY .reg, Windows .rdp, and RDCMan .rdg. You can also pick the format manually."
            });
          }
          throw error;
        }

        const { rows, existingCount } = await buildPreview(actor.organizationId, parsed.hosts);
        const importable = rows.filter((row) => row.disposition === "new").length;

        // Surface the plan ceiling here so the operator learns about it before
        // choosing options, not after clicking Import.
        const subscription = await prisma.subscription.findFirst({
          where: { organizationId: actor.organizationId },
          orderBy: { createdAt: "desc" },
          include: { plan: { select: { name: true, maxHosts: true } } }
        });
        const maxHosts = subscription?.plan.maxHosts ?? null;

        return {
          format: parsed.format,
          summary: {
            parsed: parsed.hosts.length,
            new: importable,
            existing: rows.filter((row) => row.disposition === "exists").length,
            duplicatesInFile: rows.filter((row) => row.disposition === "duplicate-in-file").length,
            skipped: parsed.issues.length
          },
          limit: {
            maxHosts,
            currentHosts: existingCount,
            planName: subscription?.plan.name ?? null,
            wouldExceed: maxHosts !== null && existingCount + importable > maxHosts,
            remaining: maxHosts === null ? null : Math.max(maxHosts - existingCount, 0)
          },
          // Cap what travels back to the browser; the summary already has totals.
          hosts: rows.slice(0, 500),
          truncatedPreview: rows.length > 500,
          issues: parsed.issues.slice(0, 200)
        };
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );

  app.post(
    "/hosts/import",
    { bodyLimit: IMPORT_BODY_LIMIT, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const actor = await getAuthenticatedUser(request);
        if (!actor) return reply.code(401).send({ error: "unauthorized" });
        if (!canManageHosts(actor.role)) return reply.code(403).send({ error: "forbidden" });

        const body = applySchema.parse(request.body);

        let parsed;
        try {
          parsed = parseHostSource({ text: body.content, filename: body.filename, format: body.format });
        } catch (error) {
          if (error instanceof UnknownFormatError) {
            return reply.code(422).send({ error: "unrecognised_format" });
          }
          throw error;
        }

        if (parsed.hosts.length === 0) {
          return reply.code(422).send({
            error: "nothing_to_import",
            message: "No usable hosts were found in this file.",
            issues: parsed.issues.slice(0, 50)
          });
        }

        const { rows, existingCount } = await buildPreview(actor.organizationId, parsed.hosts);
        const toCreate = rows.filter((row) => row.disposition === "new");
        const toUpdate = body.onDuplicate === "update" ? rows.filter((row) => row.disposition === "exists") : [];

        // Plan ceiling. Checked against what would actually be created, so
        // re-importing an unchanged file never trips it.
        const subscription = await prisma.subscription.findFirst({
          where: { organizationId: actor.organizationId },
          orderBy: { createdAt: "desc" },
          include: { plan: { select: { name: true, maxHosts: true } } }
        });
        const maxHosts = subscription?.plan.maxHosts ?? null;
        if (maxHosts !== null && existingCount + toCreate.length > maxHosts) {
          return reply.code(402).send({
            error: "host_limit_exceeded",
            message: `Your ${subscription?.plan.name ?? "current"} plan allows ${maxHosts} hosts. You have ${existingCount} and this import would add ${toCreate.length}. Upgrade, or import fewer hosts.`,
            maxHosts,
            currentHosts: existingCount,
            wouldAdd: toCreate.length
          });
        }

        const groupNames = new Set<string>();
        for (const row of [...toCreate, ...toUpdate]) {
          const group = body.groupOverride || row.group;
          if (group) groupNames.add(group);
        }
        const groupIds = await resolveGroupIds(actor.organizationId, groupNames);

        const resolveRow = (row: PreviewRow) => {
          const group = body.groupOverride || row.group;
          const tags = [...new Set([...row.tags, ...body.extraTags])].slice(0, 12);
          return {
            name: row.name,
            type: hostTypeToPrisma[row.type as HostType],
            address: row.address,
            port: row.port,
            username: row.username,
            environment: environmentToPrisma[(body.environmentOverride ?? row.environment) as Environment],
            notes: row.notes,
            groupId: group ? groupIds.get(group) : undefined,
            tags
          };
        };

        const createdIds: string[] = [];
        const failures: Array<{ sourceRef: string; message: string }> = [];

        // Chunked so one oversized file does not become one enormous transaction.
        for (let offset = 0; offset < toCreate.length; offset += INSERT_CHUNK) {
          const chunk = toCreate.slice(offset, offset + INSERT_CHUNK);

          for (const row of chunk) {
            const data = resolveRow(row);
            try {
              const host = await prisma.host.create({
                data: {
                  organizationId: actor.organizationId,
                  name: data.name,
                  type: data.type,
                  address: data.address,
                  port: data.port,
                  username: data.username,
                  environment: data.environment,
                  notes: data.notes,
                  groupId: data.groupId,
                  tags: { create: data.tags.map((name) => ({ name })) }
                },
                select: { id: true }
              });
              createdIds.push(host.id);
            } catch (error) {
              // One bad row must not abort the whole import.
              request.log.error({ err: error, sourceRef: row.sourceRef }, "Host import row failed");
              failures.push({ sourceRef: row.sourceRef, message: "Could not be saved." });
            }
          }
        }

        let updatedCount = 0;
        for (const row of toUpdate) {
          if (!row.existingHostId) continue;
          const data = resolveRow(row);
          try {
            await prisma.host.update({
              where: { id: row.existingHostId },
              data: {
                name: data.name,
                type: data.type,
                username: data.username,
                environment: data.environment,
                ...(data.notes !== undefined && { notes: data.notes }),
                ...(data.groupId !== undefined && { groupId: data.groupId }),
                ...(data.tags.length > 0 && {
                  tags: { deleteMany: {}, create: data.tags.map((name) => ({ name })) }
                })
              }
            });
            updatedCount += 1;
          } catch (error) {
            request.log.error({ err: error, sourceRef: row.sourceRef }, "Host import update failed");
            failures.push({ sourceRef: row.sourceRef, message: "Could not be updated." });
          }
        }

        // A grant-governed role would otherwise import hosts it cannot see.
        if (createdIds.length > 0 && !hasImplicitHostAccess(actor.role)) {
          await prisma.hostAccessGrant.createMany({
            data: createdIds.map((hostId) => ({
              organizationId: actor.organizationId,
              userId: actor.id,
              hostId,
              scopeKey: hostId,
              grantedById: actor.id
            })),
            skipDuplicates: true
          });
        }

        await recordAudit({
          organizationId: actor.organizationId,
          actorId: actor.id,
          action: "host.import",
          targetType: "host",
          ipAddress: request.ip,
          metadata: {
            format: parsed.format,
            created: createdIds.length,
            updated: updatedCount,
            failed: failures.length,
            skippedRows: parsed.issues.length,
            onDuplicate: body.onDuplicate
          }
        });

        return reply.code(201).send({
          format: parsed.format,
          created: createdIds.length,
          updated: updatedCount,
          skippedExisting: body.onDuplicate === "skip" ? rows.filter((row) => row.disposition === "exists").length : 0,
          duplicatesInFile: rows.filter((row) => row.disposition === "duplicate-in-file").length,
          failed: failures.length,
          failures: failures.slice(0, 50),
          issues: parsed.issues.slice(0, 50)
        });
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );

  /**
   * Exports the hosts the caller can actually see — the same access filter the
   * hosts list uses, so export is never a way around per-host permissions.
   */
  app.get("/hosts/export", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const query = exportQuerySchema.parse(request.query);
      const accessFilter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);

      const hosts = await prisma.host.findMany({
        where: {
          ...accessFilter,
          ...(query.type && { type: hostTypeToPrisma[query.type] }),
          ...(query.environment && { environment: environmentToPrisma[query.environment] }),
          ...(query.group && { group: { name: query.group } })
        },
        include: { tags: true, group: true },
        orderBy: [{ name: "asc" }]
      });

      const { body, contentType, extension } = exportHosts(
        hosts.map((host) => toHost(host)),
        query.format
      );

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "host.export",
        targetType: "host",
        ipAddress: request.ip,
        metadata: { format: query.format, count: hosts.length }
      });

      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .header("content-type", contentType)
        .header("content-disposition", `attachment; filename="onshell-hosts-${stamp}.${extension}"`)
        // A credentials-free host list is still infrastructure inventory.
        .header("cache-control", "no-store")
        .send(body);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  void MAX_IMPORT_HOSTS;
}

export type { ImportFormat };
