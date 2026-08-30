import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canManagePlatform } from "@onshell/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { describeDevice } from "../../lib/device-name.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";

/**
 * Activity logs: public-site visits, sign-in events, and outbound email.
 *
 * These tables grow without bound, so every list endpoint pages, sorts, and
 * filters in the database. Lists return only the columns the admin table shows;
 * the per-row detail endpoints return the full record.
 */

async function requirePlatformAdmin(request: FastifyRequest, config: RuntimeConfig) {
  const actor = await getAuthenticatedUser(request, config);
  return actor && canManagePlatform(actor) ? actor : undefined;
}

/** Accepts a date or datetime string and silently ignores unparseable input. */
const startDateFilter = z
  .string()
  .trim()
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  });

/**
 * Exclusive upper bound. A date-only value is pushed to the following midnight
 * so "to = today" includes everything logged today rather than nothing.
 */
const endDateFilter = z
  .string()
  .trim()
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) parsed.setUTCDate(parsed.getUTCDate() + 1);
    return parsed;
  });

const listBase = {
  take: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(160).optional(),
  direction: z.enum(["asc", "desc"]).default("desc"),
  from: startDateFilter,
  to: endDateFilter
};

const visitorListSchema = z.object({
  ...listBase,
  sort: z.enum(["createdAt", "path", "country", "ipAddress"]).default("createdAt"),
  /** "user" keeps only attributed visits, "anonymous" only unattributed ones. */
  visitor: z.enum(["all", "user", "anonymous"]).default("all"),
  country: z.string().trim().max(8).optional()
});

const authEventListSchema = z.object({
  ...listBase,
  sort: z.enum(["createdAt", "email", "event", "method", "success"]).default("createdAt"),
  event: z.enum(["LOGIN", "LOGOUT", "LOGIN_FAILED", "TWO_FACTOR_COMPLETED"]).optional(),
  method: z.enum(["PASSWORD", "GOOGLE", "TWO_FACTOR", "SESSION"]).optional(),
  outcome: z.enum(["all", "success", "failure"]).default("all")
});

const emailListSchema = z.object({
  ...listBase,
  sort: z.enum(["createdAt", "recipient", "subject", "status", "kind"]).default("createdAt"),
  status: z.enum(["SENT", "FAILED", "SKIPPED"]).optional(),
  kind: z.string().trim().max(60).optional()
});

const logIdSchema = z.object({ logId: z.string().min(1).max(60) });

const visitSchema = z.object({
  id: z.string().uuid(),
  path: z.string().trim().min(1).max(400),
  referrer: z.string().trim().max(1_000).optional(),
  visitorId: z.string().uuid(),
  sessionId: z.string().uuid(),
  title: z.string().trim().max(190).optional(),
  screenWidth: z.number().int().min(0).max(20_000).optional(),
  screenHeight: z.number().int().min(0).max(20_000).optional(),
  language: z.string().trim().max(40).optional(),
  timezone: z.string().trim().max(80).optional(),
  utm: z.object({
    source: z.string().trim().max(190).optional(),
    medium: z.string().trim().max(190).optional(),
    campaign: z.string().trim().max(190).optional(),
    content: z.string().trim().max(190).optional(),
    term: z.string().trim().max(190).optional()
  }).optional()
});

const engagementSchema = z.object({
  id: z.string().uuid(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1_000),
  engaged: z.boolean()
});

const analyticsQuerySchema = z.object({
  range: z.enum(["7d", "30d", "90d"]).default("30d")
});

const visitorSummary = {
  id: true,
  path: true,
  country: true,
  city: true,
  visitorId: true,
  sessionId: true,
  durationMs: true,
  deviceType: true,
  browser: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true } }
} satisfies Prisma.VisitorLogSelect;

const authEventSummary = {
  id: true,
  email: true,
  event: true,
  method: true,
  success: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true } }
} satisfies Prisma.AuthEventLogSelect;

const emailSummary = {
  id: true,
  recipient: true,
  subject: true,
  kind: true,
  status: true,
  createdAt: true
} satisfies Prisma.EmailLogSelect;

/**
 * Reduces a beacon path to something safe to index and group by: pathname only,
 * so query strings (which sometimes carry tokens) are never persisted.
 */
function normalizePath(raw: string) {
  const withoutQuery = raw.split(/[?#]/, 1)[0] ?? "/";
  const path = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return path.length > 1 ? path.replace(/\/+$/, "").slice(0, 190) || "/" : "/";
}

/**
 * Same reasoning as normalizePath, applied to the referrer: an invite link is
 * `/invite?token=…`, so a visitor navigating away from it would otherwise carry
 * a live token into a log that platform admins can read. Origin and pathname are
 * all the attribution needs.
 */
function normalizeReferrer(raw: string | undefined) {
  if (!raw) return null;

  try {
    const url = new URL(raw);
    // Only http(s) referrers are meaningful; anything else is dropped.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";
    return `${url.origin}${pathname}`.slice(0, 500);
  } catch {
    // Not a parseable URL — keep the origin-shaped prefix only, never a query.
    return raw.split(/[?#]/, 1)[0]?.slice(0, 500) || null;
  }
}

/** Geo header names used by the CDNs this deployment can sit behind. */
function readCountry(request: FastifyRequest) {
  const header =
    request.headers["cf-ipcountry"] ??
    request.headers["x-vercel-ip-country"] ??
    request.headers["x-geo-country"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value === "XX") return null;
  return value.slice(0, 8).toUpperCase();
}

function readHeader(request: FastifyRequest, names: string[]) {
  for (const name of names) {
    const header = request.headers[name];
    const value = Array.isArray(header) ? header[0] : header;
    if (value) {
      try {
        return decodeURIComponent(value).slice(0, 190);
      } catch {
        return value.slice(0, 190);
      }
    }
  }
  return null;
}

function deviceType(userAgent: string | undefined) {
  if (!userAgent) return "unknown";
  if (/bot|crawler|spider|slurp|bingpreview/i.test(userAgent)) return "bot";
  if (/ipad|tablet|kindle|silk/i.test(userAgent)) return "tablet";
  if (/mobile|iphone|ipod|android/i.test(userAgent)) return "mobile";
  return "desktop";
}

function createdAtRange(from?: Date, to?: Date) {
  if (!from && !to) return {};
  return { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } };
}

export async function registerLogRoutes(app: FastifyInstance, config: RuntimeConfig) {
  /**
   * Page-view beacon for the public site. Unauthenticated by design, but the
   * session cookie is read when present so visits can be attributed.
   */
  app.post(
    "/public/visit",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const body = visitSchema.parse(request.body);
        const path = normalizePath(body.path);
        // Never required — an anonymous visit is still worth recording.
        const visitor = await getAuthenticatedUser(request, config).catch(() => null);
        const userAgent = request.headers["user-agent"]?.slice(0, 500);
        const device = describeDevice(userAgent);
        const resolvedDeviceType = deviceType(userAgent);
        // Match mainstream analytics products: known crawlers do not count as
        // people or inflate engagement metrics.
        if (resolvedDeviceType === "bot") return reply.code(202).send({ ok: true, recorded: false });

        await prisma.visitorLog.create({
          data: {
            id: body.id,
            path,
            referrer: normalizeReferrer(body.referrer),
            userId: visitor?.id ?? null,
            ipAddress: request.ip,
            userAgent: userAgent ?? null,
            country: readCountry(request),
            region: readHeader(request, ["cf-region", "x-vercel-ip-country-region", "x-geo-region"]),
            city: readHeader(request, ["cf-ipcity", "x-vercel-ip-city", "x-geo-city"]),
            visitorId: body.visitorId,
            sessionId: body.sessionId,
            title: body.title,
            screenWidth: body.screenWidth,
            screenHeight: body.screenHeight,
            language: body.language,
            timezone: body.timezone,
            browser: device.browser ?? "Unknown",
            os: device.os ?? "Unknown",
            deviceType: resolvedDeviceType,
            utmSource: body.utm?.source,
            utmMedium: body.utm?.medium,
            utmCampaign: body.utm?.campaign,
            utmContent: body.utm?.content,
            utmTerm: body.utm?.term
          },
          select: { id: true }
        });

        return reply.code(202).send({ ok: true, recorded: true });
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );

  /** Updates active time for a page view. The random view id is the capability;
   * no identity or cookie is needed, so pagehide beacons remain reliable. */
  app.post(
    "/public/visit/engagement",
    { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const body = engagementSchema.parse(request.body);
        await prisma.visitorLog.updateMany({
          where: { id: body.id },
          data: { durationMs: body.durationMs, engaged: body.engaged }
        });
        return reply.code(202).send({ ok: true });
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );

  app.get("/admin/analytics/overview", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });
      const { range } = analyticsQuerySchema.parse(request.query);
      const days = Number(range.slice(0, -1));
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const where = { createdAt: { gte: from } } satisfies Prisma.VisitorLogWhereInput;

      const [views, aggregate, distinct, trend, pages, countries, browsers, devices, sources, recent] = await Promise.all([
        prisma.visitorLog.count({ where }),
        prisma.visitorLog.aggregate({ where, _avg: { durationMs: true }, _sum: { durationMs: true } }),
        prisma.$queryRaw<Array<{ visitors: bigint; sessions: bigint }>>(Prisma.sql`
          SELECT COUNT(DISTINCT visitorId) visitors, COUNT(DISTINCT sessionId) sessions
          FROM VisitorLog WHERE createdAt >= ${from}
        `),
        prisma.$queryRaw<Array<{ day: Date | string; views: bigint; visitors: bigint; sessions: bigint }>>(Prisma.sql`
          SELECT DATE(createdAt) day, COUNT(*) views,
                 COUNT(DISTINCT visitorId) visitors, COUNT(DISTINCT sessionId) sessions
          FROM VisitorLog WHERE createdAt >= ${from}
          GROUP BY DATE(createdAt) ORDER BY day ASC
        `),
        prisma.visitorLog.groupBy({ by: ["path"], where, _count: { _all: true }, _avg: { durationMs: true }, orderBy: { _count: { path: "desc" } }, take: 12 }),
        prisma.visitorLog.groupBy({ by: ["country"], where, _count: { _all: true }, orderBy: { _count: { country: "desc" } }, take: 10 }),
        prisma.visitorLog.groupBy({ by: ["browser"], where, _count: { _all: true }, orderBy: { _count: { browser: "desc" } }, take: 8 }),
        prisma.visitorLog.groupBy({ by: ["deviceType"], where, _count: { _all: true }, orderBy: { _count: { deviceType: "desc" } } }),
        prisma.$queryRaw<Array<{ name: string; views: bigint }>>(Prisma.sql`
          SELECT COALESCE(utmSource, referrer, 'Direct') name, COUNT(*) views
          FROM VisitorLog WHERE createdAt >= ${from}
          GROUP BY COALESCE(utmSource, referrer, 'Direct')
          ORDER BY views DESC LIMIT 10
        `),
        prisma.visitorLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 20, select: visitorSummary })
      ]);

      const visitorCount = Number(distinct[0]?.visitors ?? 0);
      const sessionCount = Number(distinct[0]?.sessions ?? 0);
      const bounced = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) count FROM (
          SELECT sessionId FROM VisitorLog
          WHERE createdAt >= ${from} AND sessionId IS NOT NULL
          GROUP BY sessionId HAVING COUNT(*) = 1 AND MAX(durationMs) < 10000
        ) single_page_sessions
      `);

      return {
        range,
        totals: {
          views,
          visitors: visitorCount,
          sessions: sessionCount,
          averageDurationMs: Math.round(aggregate._avg.durationMs ?? 0),
          totalDurationMs: aggregate._sum.durationMs ?? 0,
          bounceRate: sessionCount ? Math.round((Number(bounced[0]?.count ?? 0) / sessionCount) * 1000) / 10 : 0
        },
        trend: trend.map((row) => ({ day: new Date(row.day).toISOString().slice(0, 10), views: Number(row.views), visitors: Number(row.visitors), sessions: Number(row.sessions) })),
        pages: pages.map((row) => ({ path: row.path, views: row._count._all, averageDurationMs: Math.round(row._avg.durationMs ?? 0) })),
        countries: countries.map((row) => ({ name: row.country ?? "Unknown", views: row._count._all })),
        browsers: browsers.map((row) => ({ name: row.browser ?? "Unknown", views: row._count._all })),
        devices: devices.map((row) => ({ name: row.deviceType ?? "Unknown", views: row._count._all })),
        sources: sources.map((row) => ({ name: row.name, views: Number(row.views) })),
        recent
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/logs/visitors", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const query = visitorListSchema.parse(request.query);
      const where: Prisma.VisitorLogWhereInput = {
        ...createdAtRange(query.from, query.to),
        ...(query.visitor === "user" ? { userId: { not: null } } : {}),
        ...(query.visitor === "anonymous" ? { userId: null } : {}),
        ...(query.country ? { country: query.country.toUpperCase() } : {}),
        ...(query.search
          ? {
              OR: [
                { path: { contains: query.search } },
                { ipAddress: { contains: query.search } },
                { country: { contains: query.search } },
                { user: { name: { contains: query.search } } },
                { user: { email: { contains: query.search } } }
              ]
            }
          : {})
      };

      const [total, rows] = await Promise.all([
        prisma.visitorLog.count({ where }),
        prisma.visitorLog.findMany({
          where,
          orderBy: { [query.sort]: query.direction },
          take: query.take,
          skip: query.skip,
          select: visitorSummary
        })
      ]);

      return { total, take: query.take, skip: query.skip, rows };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/logs/visitors/:logId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { logId } = logIdSchema.parse(request.params);
      const row = await prisma.visitorLog.findUnique({
        where: { id: logId },
        include: { user: { select: { id: true, name: true, email: true } } }
      });
      if (!row) return reply.code(404).send({ error: "log_not_found" });

      return row;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/logs/auth-events", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const query = authEventListSchema.parse(request.query);
      const where: Prisma.AuthEventLogWhereInput = {
        ...createdAtRange(query.from, query.to),
        ...(query.event ? { event: query.event } : {}),
        ...(query.method ? { method: query.method } : {}),
        ...(query.outcome === "all" ? {} : { success: query.outcome === "success" }),
        ...(query.search
          ? {
              OR: [
                { email: { contains: query.search } },
                { ipAddress: { contains: query.search } },
                { reason: { contains: query.search } },
                { user: { name: { contains: query.search } } }
              ]
            }
          : {})
      };

      const [total, rows] = await Promise.all([
        prisma.authEventLog.count({ where }),
        prisma.authEventLog.findMany({
          where,
          orderBy: { [query.sort]: query.direction },
          take: query.take,
          skip: query.skip,
          select: authEventSummary
        })
      ]);

      return { total, take: query.take, skip: query.skip, rows };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/logs/auth-events/:logId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { logId } = logIdSchema.parse(request.params);
      const row = await prisma.authEventLog.findUnique({
        where: { id: logId },
        include: { user: { select: { id: true, name: true, email: true } } }
      });
      if (!row) return reply.code(404).send({ error: "log_not_found" });

      return row;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/logs/emails", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const query = emailListSchema.parse(request.query);
      const where: Prisma.EmailLogWhereInput = {
        ...createdAtRange(query.from, query.to),
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.search
          ? {
              OR: [
                { recipient: { contains: query.search } },
                { subject: { contains: query.search } },
                { kind: { contains: query.search } },
                { providerMessageId: { contains: query.search } }
              ]
            }
          : {})
      };

      const [total, rows, kinds] = await Promise.all([
        prisma.emailLog.count({ where }),
        prisma.emailLog.findMany({
          where,
          orderBy: { [query.sort]: query.direction },
          take: query.take,
          skip: query.skip,
          select: emailSummary
        }),
        // Templates in use, so the kind filter offers real values rather than a
        // hard-coded list that drifts as templates are added.
        prisma.emailLog.groupBy({ by: ["kind"], orderBy: { kind: "asc" } })
      ]);

      return {
        total,
        take: query.take,
        skip: query.skip,
        rows,
        kinds: kinds.map((entry) => entry.kind)
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/logs/emails/:logId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { logId } = logIdSchema.parse(request.params);
      const row = await prisma.emailLog.findUnique({ where: { id: logId } });
      if (!row) return reply.code(404).send({ error: "log_not_found" });

      return row;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
