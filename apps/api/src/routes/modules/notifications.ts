import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canManagePlatform } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";

const createSchema = z.object({
  title: z.string().trim().min(2).max(120),
  message: z.string().trim().min(2).max(4000),
  actionUrl: z.string().trim().url().max(500).optional(),
  expiresAt: z.string().datetime().optional()
});

const DESKTOP_RELEASE_API =
  process.env.ONSHELL_RELEASES_API ??
  "https://api.github.com/repos/latifurrahmanlemon/onshell-downloads/releases/latest";

async function syncLatestDesktopRelease() {
  try {
    const response = await fetch(DESKTOP_RELEASE_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "onshell-api" },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return;
    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      draft?: boolean;
      prerelease?: boolean;
    };
    if (!release.tag_name?.startsWith("desktop-v") || !release.html_url || release.draft || release.prerelease) return;
    const exists = await prisma.appNotification.findFirst({
      where: { actionUrl: release.html_url },
      select: { id: true }
    });
    if (exists) return;
    const version = release.tag_name.replace(/^desktop-v/, "");
    await prisma.appNotification.create({
      data: {
        title: `Onshell Desktop ${version} is available`,
        message: "A new verified desktop build is ready. Review the release notes and checksums before installing.",
        actionUrl: release.html_url
      }
    });
  } catch {
    // Release discovery is best-effort. Offline deployments retry later and
    // must never fail API startup merely because GitHub is unavailable.
  }
}

export async function registerNotificationRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/notifications", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const now = new Date();
      const rows = await prisma.appNotification.findMany({
        where: { publishedAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        include: { reads: { where: { userId: actor.id }, select: { readAt: true } } },
        orderBy: { publishedAt: "desc" }, take: 50
      });
      return { notifications: rows.map(({ reads, ...row }) => ({ ...row, publishedAt: row.publishedAt.toISOString(), expiresAt: row.expiresAt?.toISOString(), createdAt: row.createdAt.toISOString(), read: reads.length > 0 })) };
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.post("/notifications/:id/read", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const exists = await prisma.appNotification.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return reply.code(404).send({ error: "notification_not_found" });
      await prisma.notificationRead.upsert({ where: { notificationId_userId: { notificationId: id, userId: actor.id } }, update: { readAt: new Date() }, create: { notificationId: id, userId: actor.id } });
      return { ok: true };
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.post("/admin/notifications", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor || !canManagePlatform(actor)) return reply.code(403).send({ error: "forbidden" });
      const body = createSchema.parse(request.body);
      const notification = await prisma.appNotification.create({ data: { title: body.title, message: body.message, actionUrl: body.actionUrl, expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined } });
      return reply.code(201).send(notification);
    } catch (error) { return handleRouteError(reply, error); }
  });

  void syncLatestDesktopRelease();
  const releaseTimer = setInterval(() => void syncLatestDesktopRelease(), 15 * 60 * 1000);
  releaseTimer.unref();
  app.addHook("onClose", async () => clearInterval(releaseTimer));
}
