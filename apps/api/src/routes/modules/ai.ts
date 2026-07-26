import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { z } from "zod";
import {
  AiConfigurationError,
  AiUpstreamError,
  CONTEXT_MESSAGE_LIMIT,
  createAiCompletion,
  deriveThreadTitle,
  getAiSetting,
  type AiChatMessage
} from "../../lib/ai.js";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";

const MAX_MESSAGE_LENGTH = 6_000;
const MAX_THREADS_PER_USER = 200;

const sendMessageSchema = z.object({
  /** Omit to start a new thread; supply to continue an existing one. */
  threadId: z.string().min(1).optional(),
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH)
});

const threadParamsSchema = z.object({ threadId: z.string().min(1) });

const renameThreadSchema = z.object({ title: z.string().trim().min(1).max(120) });

function startOfMonth() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Resolves this user's monthly message allowance.
 *
 * The plan is authoritative (that is what the customer paid for); the global
 * AiSetting cap is the fallback for organizations with no subscription. A null
 * plan allowance means unlimited.
 */
async function resolveMessageQuota(organizationId: string, fallbackCap: number) {
  const subscription = await prisma.subscription.findFirst({
    where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
    orderBy: { createdAt: "desc" },
    include: { plan: { select: { monthlyAiMessages: true, name: true, code: true } } }
  });

  if (!subscription) return { limit: fallbackCap, planName: null as string | null };
  if (subscription.plan.monthlyAiMessages === null) {
    return { limit: null, planName: subscription.plan.name };
  }
  return { limit: subscription.plan.monthlyAiMessages, planName: subscription.plan.name };
}

/** Counts the user's own prompts this calendar month across all their threads. */
async function countMonthlyMessages(userId: string) {
  return prisma.aiMessage.count({
    where: {
      role: "USER",
      createdAt: { gte: startOfMonth() },
      thread: { userId }
    }
  });
}

export async function registerAiRoutes(app: FastifyInstance, config: RuntimeConfig) {
  /** Assistant availability plus the caller's remaining monthly allowance. */
  app.get("/ai/status", async (request, reply) => {
    const user = await getAuthenticatedUser(request, config);
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const setting = await getAiSetting();
    const enabled = Boolean(setting?.enabled && setting.encryptedApiKey);
    if (!enabled) {
      return { enabled: false, model: null, used: 0, limit: 0, remaining: 0, planName: null };
    }

    const [{ limit, planName }, used] = await Promise.all([
      resolveMessageQuota(user.organizationId, setting?.monthlyMessageCap ?? 0),
      countMonthlyMessages(user.id)
    ]);

    return {
      enabled: true,
      model: setting?.model ?? null,
      used,
      limit,
      remaining: limit === null ? null : Math.max(limit - used, 0),
      planName
    };
  });

  app.get("/ai/threads", async (request, reply) => {
    const user = await getAuthenticatedUser(request, config);
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const threads = await prisma.aiThread.findMany({
      where: { userId: user.id, archivedAt: null },
      orderBy: { lastMessageAt: "desc" },
      take: 100,
      select: {
        id: true,
        title: true,
        messageCount: true,
        lastMessageAt: true,
        createdAt: true
      }
    });

    return threads;
  });

  app.get("/ai/threads/:threadId", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const { threadId } = threadParamsSchema.parse(request.params);
      // Scope the lookup to the owner so a guessed id cannot read another
      // user's conversation, and return 404 rather than 403 to avoid
      // confirming that the id exists.
      const thread = await prisma.aiThread.findFirst({
        where: { id: threadId, userId: user.id },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
            select: { id: true, role: true, content: true, createdAt: true }
          }
        }
      });
      if (!thread) return reply.code(404).send({ error: "thread_not_found" });

      return {
        id: thread.id,
        title: thread.title,
        messageCount: thread.messageCount,
        lastMessageAt: thread.lastMessageAt,
        createdAt: thread.createdAt,
        messages: thread.messages
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/ai/threads/:threadId", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const { threadId } = threadParamsSchema.parse(request.params);
      const body = renameThreadSchema.parse(request.body);

      const updated = await prisma.aiThread.updateMany({
        where: { id: threadId, userId: user.id },
        data: { title: body.title }
      });
      if (updated.count === 0) return reply.code(404).send({ error: "thread_not_found" });

      return { ok: true, title: body.title };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/ai/threads/:threadId", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const { threadId } = threadParamsSchema.parse(request.params);
      const deleted = await prisma.aiThread.deleteMany({
        where: { id: threadId, userId: user.id }
      });
      if (deleted.count === 0) return reply.code(404).send({ error: "thread_not_found" });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * Sends one prompt and returns the assistant's reply.
   *
   * Both sides of the exchange are persisted so the thread survives a reload and
   * platform admins can review conversations. The provider call is rate limited
   * per user because each request costs real money upstream.
   */
  app.post(
    "/ai/messages",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const user = await getAuthenticatedUser(request, config);
        if (!user) return reply.code(401).send({ error: "unauthorized" });

        const body = sendMessageSchema.parse(request.body);
        const setting = await getAiSetting();
        if (!setting?.enabled || !setting.encryptedApiKey) {
          return reply.code(503).send({
            error: "ai_disabled",
            message: "The AI assistant is not enabled. Ask a platform admin to configure it."
          });
        }

        const [{ limit, planName }, used] = await Promise.all([
          resolveMessageQuota(user.organizationId, setting.monthlyMessageCap),
          countMonthlyMessages(user.id)
        ]);

        if (limit !== null && used >= limit) {
          return reply.code(402).send({
            error: "ai_quota_exceeded",
            message: `You've used all ${limit} AI messages included with your ${planName ?? "current"} plan this month. Upgrade for more.`,
            used,
            limit
          });
        }

        // Resolve or create the thread before calling the provider so a failed
        // completion still leaves the user's question recorded.
        let thread = body.threadId
          ? await prisma.aiThread.findFirst({ where: { id: body.threadId, userId: user.id } })
          : null;

        if (body.threadId && !thread) return reply.code(404).send({ error: "thread_not_found" });

        if (!thread) {
          const threadCount = await prisma.aiThread.count({ where: { userId: user.id, archivedAt: null } });
          if (threadCount >= MAX_THREADS_PER_USER) {
            return reply.code(409).send({
              error: "too_many_threads",
              message: "You've reached the conversation limit. Delete an old thread to start a new one."
            });
          }

          thread = await prisma.aiThread.create({
            data: {
              organizationId: user.organizationId,
              userId: user.id,
              title: deriveThreadTitle(body.message)
            }
          });
        }

        const history = await prisma.aiMessage.findMany({
          where: { threadId: thread.id },
          orderBy: { createdAt: "desc" },
          take: CONTEXT_MESSAGE_LIMIT,
          select: { role: true, content: true }
        });

        const contextMessages: AiChatMessage[] = history
          .reverse()
          .filter((entry) => entry.role !== "SYSTEM")
          .map((entry) => ({
            role: entry.role === "ASSISTANT" ? "assistant" : "user",
            content: entry.content
          }));

        const userMessage = await prisma.aiMessage.create({
          data: { threadId: thread.id, role: "USER", content: body.message }
        });

        let completion;
        try {
          completion = await createAiCompletion({
            messages: [...contextMessages, { role: "user", content: body.message }],
            masterEncryptionKey: config.masterEncryptionKey
          });
        } catch (error) {
          request.log.error({ err: error, threadId: thread.id }, "AI completion failed");

          if (error instanceof AiConfigurationError) {
            return reply.code(503).send({
              error: error.code,
              message: "The AI assistant is not configured correctly. A platform admin needs to review it.",
              threadId: thread.id,
              userMessageId: userMessage.id
            });
          }

          if (error instanceof AiUpstreamError) {
            const status = error.status === 429 ? 429 : 502;
            return reply.code(status).send({
              error: status === 429 ? "ai_rate_limited" : "ai_upstream_error",
              message:
                status === 429
                  ? "The AI provider is rate limiting us right now. Try again in a moment."
                  : "The AI provider could not answer that. Try again in a moment.",
              threadId: thread.id,
              userMessageId: userMessage.id
            });
          }

          return reply.code(502).send({
            error: "ai_upstream_error",
            message: "The AI assistant is temporarily unavailable.",
            threadId: thread.id,
            userMessageId: userMessage.id
          });
        }

        const assistantMessage = await prisma.aiMessage.create({
          data: {
            threadId: thread.id,
            role: "ASSISTANT",
            content: completion.content,
            model: completion.model,
            promptTokens: completion.promptTokens,
            outputTokens: completion.outputTokens
          }
        });

        const refreshed = await prisma.aiThread.update({
          where: { id: thread.id },
          data: {
            lastMessageAt: new Date(),
            messageCount: { increment: 2 }
          },
          select: { id: true, title: true, messageCount: true, lastMessageAt: true }
        });

        return {
          thread: refreshed,
          userMessage: {
            id: userMessage.id,
            role: "USER" as const,
            content: userMessage.content,
            createdAt: userMessage.createdAt
          },
          assistantMessage: {
            id: assistantMessage.id,
            role: "ASSISTANT" as const,
            content: assistantMessage.content,
            createdAt: assistantMessage.createdAt
          },
          usage: {
            used: used + 1,
            limit,
            remaining: limit === null ? null : Math.max(limit - used - 1, 0)
          }
        };
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );
}
