import type { FastifyReply, FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canManagePlatform } from "@onshell/shared";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { handleRouteError } from "../../lib/reply.js";
import { organizationLogo } from "../../lib/organization-logo.js";

const text = (max: number) => z.string().trim().max(max);
const content = z.object({
  slug: text(150)
    .min(2)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .refine((s) => !["feed", "feed-xml", "image"].includes(s)),
  title: text(180).min(3),
  category: text(80).min(2),
  description: text(350),
  answer: text(5000),
  sections: z
    .array(
      z.object({
        heading: text(180).min(1),
        paragraphs: z.array(text(10000).min(1)).min(1).max(30),
      }),
    )
    .max(40),
  checklist: z.array(text(500).min(1)).max(20),
  productLink: text(190).regex(/^\/(?!\/)[a-zA-Z0-9/_-]*$/),
  authorName: text(120).min(1),
  seoTitle: text(180),
  seoDescription: text(350),
  coverImage: z.custom<string | null>(
    (v) => organizationLogo.safeParse(v).success,
    "Choose a PNG, JPEG or WebP image under 300 KB.",
  ),
  coverAlt: text(180),
  status: z.enum(["DRAFT", "PUBLISHED"]),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
});
export const communityPostSchema = content.superRefine((post, ctx) => {
  if (
    post.status === "PUBLISHED" &&
    (!post.publishedAt ||
      !post.description ||
      !post.answer ||
      !post.sections.length)
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "Publishing requires a date, summary, short answer and at least one section.",
    });
  }
  if (post.coverImage && !post.coverAlt)
    ctx.addIssue({
      code: "custom",
      path: ["coverAlt"],
      message: "Describe the cover image for accessibility.",
    });
});
const querySchema = z.object({
  search: text(120).default(""),
  category: text(80).default(""),
  status: z.enum(["all", "draft", "scheduled", "published"]).default("all"),
  take: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).default(0),
});
export const publishedWhere = (now = new Date()) => ({
  status: "PUBLISHED",
  publishedAt: { lte: now },
});
function publicPost(
  post: {
    sections: unknown;
    checklist: unknown;
    publishedAt: Date | null;
    updatedAt: Date;
    [key: string]: unknown;
  },
  detail = false,
) {
  const sections = post.sections as { heading: string; paragraphs: string[] }[];
  const checklist = post.checklist as string[];
  const readingMinutes = Math.max(
    1,
    Math.ceil(
      [post.answer, ...sections.flatMap((s) => s.paragraphs), ...checklist]
        .join(" ")
        .split(/\s+/).length / 200,
    ),
  );
  return {
    slug: post.slug,
    title: post.title,
    category: post.category,
    description: post.description,
    answer: detail ? post.answer : "",
    sections: detail ? sections : [],
    checklist: detail ? checklist : [],
    productLink: post.productLink,
    authorName: post.authorName,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    coverImage: detail ? post.coverImage : null,
    coverAlt: post.coverAlt,
    publishedAt: post.publishedAt!.toISOString(),
    modifiedAt: new Date(
      Math.max(post.updatedAt.getTime(), post.publishedAt!.getTime()),
    ).toISOString(),
    readingMinutes,
  };
}

function communityError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError)
    return reply
      .code(400)
      .send({
        error: "validation_failed",
        message: error.issues
          .map((issue) => `${issue.path.join(".") || "Post"}: ${issue.message}`)
          .join("; "),
      });
  if ((error as { code?: string })?.code === "P2002")
    return reply
      .code(409)
      .send({
        error: "slug_taken",
        message: "Another post uses this URL slug. Choose a unique slug.",
      });
  return handleRouteError(reply, error);
}

export async function registerCommunityRoutes(
  app: FastifyInstance,
  config: RuntimeConfig,
) {
  app.get("/public/community", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const posts = await prisma.communityPost.findMany({
        where: publishedWhere(),
        orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
        omit: { coverImage: true },
      });
      return posts.map((post) => publicPost(post));
    } catch (error) {
      return communityError(reply, error);
    }
  });
  app.get("/public/community/:slug", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const { slug } = z.object({ slug: text(150) }).parse(request.params);
      const post = await prisma.communityPost.findFirst({
        where: { slug, ...publishedWhere() },
      });
      if (!post) return reply.code(404).send({ error: "not_found" });
      return publicPost(post, true);
    } catch (error) {
      return communityError(reply, error);
    }
  });
  // Encapsulated hook protects list, details, preview data and every mutation.
  await app.register(async (admin) => {
    admin.addHook("preHandler", async (request, reply) => {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManagePlatform(actor))
        return reply.code(403).send({ error: "forbidden" });
    });
    admin.get("/admin/community", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const q = querySchema.parse(request.query);
        const now = new Date();
        const where = {
          ...(q.search
            ? {
                OR: [
                  { title: { contains: q.search } },
                  { slug: { contains: q.search } },
                  { description: { contains: q.search } },
                ],
              }
            : {}),
          ...(q.category ? { category: q.category } : {}),
          ...(q.status === "draft"
            ? { status: "DRAFT" }
            : q.status === "scheduled"
              ? { status: "PUBLISHED", publishedAt: { gt: now } }
              : q.status === "published"
                ? publishedWhere(now)
                : {}),
        };
        const [posts, total, categories] = await Promise.all([
          prisma.communityPost.findMany({
            where,
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take: q.take,
            skip: q.skip,
            select: {
              id: true,
              slug: true,
              title: true,
              category: true,
              status: true,
              authorName: true,
              publishedAt: true,
              updatedAt: true,
              version: true,
            },
          }),
          prisma.communityPost.count({ where }),
          prisma.communityPost.findMany({
            distinct: ["category"],
            select: { category: true },
            orderBy: { category: "asc" },
          }),
        ]);
        return { posts, total, categories: categories.map((c) => c.category) };
      } catch (error) {
        return communityError(reply, error);
      }
    });
    admin.get("/admin/community/:id", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const { id } = z.object({ id: text(191) }).parse(request.params);
        const post = await prisma.communityPost.findUnique({ where: { id } });
        return post ?? reply.code(404).send({ error: "not_found" });
      } catch (error) {
        return communityError(reply, error);
      }
    });
    admin.post("/admin/community", async (request, reply) => {
      try {
        const body = communityPostSchema.parse(request.body);
        const actor = (await getAuthenticatedUser(request, config))!;
        const post = await prisma.$transaction(async (tx) => {
          const created = await tx.communityPost.create({
            data: {
              ...body,
              publishedAt: body.publishedAt ? new Date(body.publishedAt) : null,
            },
          });
          await tx.auditLog.create({
            data: {
              organizationId: actor.organizationId,
              actorId: actor.id,
              action: "community.create",
              targetType: "community_post",
              targetId: created.id,
              ipAddress: request.ip,
            },
          });
          return created;
        });
        return reply.code(201).send(post);
      } catch (error) {
        return communityError(reply, error);
      }
    });
    admin.patch("/admin/community/:id", async (request, reply) => {
      try {
        const { id } = z.object({ id: text(191) }).parse(request.params);
        const { version } = z
          .object({ version: z.number().int().positive() })
          .parse(request.body);
        const body = communityPostSchema.parse(request.body);
        const actor = (await getAuthenticatedUser(request, config))!;
        const post = await prisma.$transaction(async (tx) => {
          const result = await tx.communityPost.updateMany({
            where: { id, version },
            data: {
              ...body,
              publishedAt: body.publishedAt ? new Date(body.publishedAt) : null,
              version: { increment: 1 },
            },
          });
          if (!result.count) return null;
          await tx.auditLog.create({
            data: {
              organizationId: actor.organizationId,
              actorId: actor.id,
              action: "community.update",
              targetType: "community_post",
              targetId: id,
              ipAddress: request.ip,
            },
          });
          return tx.communityPost.findUnique({ where: { id } });
        });
        if (!post)
          return reply
            .code(409)
            .send({
              error: "edit_conflict",
              message:
                "This post changed or was deleted. Keep your text, reload the post and merge your changes.",
            });
        return post;
      } catch (error) {
        return communityError(reply, error);
      }
    });
    admin.delete("/admin/community/:id", async (request, reply) => {
      try {
        const { id } = z.object({ id: text(191) }).parse(request.params);
        const { version } = z
          .object({ version: z.number().int().positive() })
          .parse(request.body);
        const actor = (await getAuthenticatedUser(request, config))!;
        const deleted = await prisma.$transaction(async (tx) => {
          const result = await tx.communityPost.deleteMany({
            where: { id, version },
          });
          if (result.count)
            await tx.auditLog.create({
              data: {
                organizationId: actor.organizationId,
                actorId: actor.id,
                action: "community.delete",
                targetType: "community_post",
                targetId: id,
                ipAddress: request.ip,
              },
            });
          return result.count;
        });
        if (!deleted)
          return reply
            .code(409)
            .send({
              error: "edit_conflict",
              message:
                "This post changed or was already deleted. Refresh the list before deleting.",
            });
        return { deleted: true };
      } catch (error) {
        return communityError(reply, error);
      }
    });
  });
}
