import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { z } from "zod";
import {
  AiConfigurationError,
  AiUpstreamError,
  createAiCompletion,
  DEFAULT_SYSTEM_PROMPT,
  getAiSetting,
  getPublicAiConfig,
  type AiChatMessage
} from "../../lib/ai.js";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { sendTransactionalEmail } from "../../lib/email.js";
import { contactNotificationEmail } from "../../lib/email-template.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";
import {
  getPublicTurnstileConfig,
  readTurnstileToken,
  turnstileFailureResponse,
  verifyTurnstile
} from "../../lib/turnstile.js";

/** Topics the contact form offers, mirrored by the web form's select. */
const contactTopics = ["general", "sales", "support", "security", "partnership"] as const;

const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z
    .string()
    .email()
    .transform((value) => value.trim().toLowerCase()),
  company: z.string().trim().max(160).optional(),
  topic: z.enum(contactTopics).default("general"),
  message: z.string().trim().min(20).max(5_000),
  turnstileToken: z.string().optional()
});

/** How many prior guest turns are replayed. Bounds the prompt an anonymous caller can build. */
const GUEST_CONTEXT_LIMIT = 10;

/**
 * Narrows the configured assistant prompt for visitors with no account: it must
 * never imply it can act inside a workspace it cannot see.
 */
const GUEST_PROMPT_SUFFIX = [
  "",
  "",
  "You are talking to a visitor on the public Onshell.cloud website who may not have an account yet.",
  "- Answer questions about what Onshell.cloud does, its plans, its security model, and how to get started; general Linux, shell, and SSH questions are fair game too.",
  "- You cannot see or change anything in a workspace — no hosts, no credentials, no sessions, no billing. If they want something done in the product, say where in the console to do it.",
  "- Never ask for passwords, private keys, or card details. Point them at /signup to start free, /login to sign in, or /contact to reach a human.",
  "- Keep it short: two or three sentences unless they asked for a command or a config snippet."
].join("\n");

const guestChatSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  /** Prior turns, replayed by the client because nothing is stored server-side. */
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(4_000)
      })
    )
    .max(GUEST_CONTEXT_LIMIT * 2)
    .default([])
});

const newsletterSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.trim().toLowerCase()),
  source: z.string().trim().max(60).default("footer"),
  turnstileToken: z.string().optional()
});

export async function registerPublicRoutes(app: FastifyInstance, config: RuntimeConfig) {
  /**
   * Runtime configuration the public site needs before rendering its forms.
   * Served from the API rather than baked into the bundle so an admin can rotate
   * the Turnstile site key or toggle the AI assistant without a rebuild.
   */
  app.get("/public/site-config", async (_request, reply) => {
    const [turnstile, ai] = await Promise.all([getPublicTurnstileConfig(), getPublicAiConfig()]);

    // Never cache this. It decides whether the browser renders a Turnstile
    // widget, so a stale copy served by a CDN or the browser's heuristic cache
    // means a visitor is shown no challenge while the API has started requiring
    // one — every login then fails with captcha_required and nothing on screen
    // to solve. The payload is tiny and read once per page load.
    reply.header("cache-control", "no-store");

    return {
      site: {
        name: "Onshell.cloud",
        domain: "onshell.cloud",
        url: config.siteUrl,
        supportEmail: "support@onshell.cloud"
      },
      turnstile,
      ai: { enabled: ai.enabled }
    };
  });

  app.post(
    "/contact",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      try {
        const body = contactSchema.parse(request.body);

        const verification = await verifyTurnstile({
          form: "contact",
          token: readTurnstileToken(request.body),
          remoteIp: request.ip,
          masterEncryptionKey: config.masterEncryptionKey,
          logger: request.log
        });
        if (!verification.ok) {
          const failure = turnstileFailureResponse(verification);
          return reply.code(failure.status).send(failure.body);
        }

        // Attach the signed-in user when there is one, so support has context.
        // Never required — the form works for anonymous visitors.
        const submitter = await getAuthenticatedUser(request, config).catch(() => null);

        const created = await prisma.contactMessage.create({
          data: {
            name: body.name,
            email: body.email,
            company: body.company || null,
            topic: body.topic,
            message: body.message,
            ipAddress: request.ip,
            userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null,
            submittedById: submitter?.id ?? null
          },
          select: { id: true, createdAt: true }
        });

        // Best-effort notification. A failed send must not fail the submission —
        // the message is already durable and visible in the admin inbox.
        const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL?.trim() || "support@onshell.cloud";
        const message = contactNotificationEmail({
          name: body.name,
          email: body.email,
          company: body.company,
          topic: body.topic,
          message: body.message,
          adminUrl: `${config.siteUrl}/admin?section=inbox&message=${created.id}`,
          siteUrl: config.siteUrl
        });
        void sendTransactionalEmail({
          masterEncryptionKey: config.masterEncryptionKey,
          recipient: notifyEmail,
          subject: message.subject,
          text: message.text,
          html: message.html,
          kind: "contact_notification",
          logger: app.log
        });

        return reply.code(201).send({
          ok: true,
          id: created.id,
          message: "Thanks — your message is with our team. We usually reply within one business day."
        });
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );

  app.post(
    "/newsletter",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      try {
        const body = newsletterSchema.parse(request.body);

        const verification = await verifyTurnstile({
          form: "newsletter",
          token: readTurnstileToken(request.body),
          remoteIp: request.ip,
          masterEncryptionKey: config.masterEncryptionKey,
          logger: request.log
        });
        if (!verification.ok) {
          const failure = turnstileFailureResponse(verification);
          return reply.code(failure.status).send(failure.body);
        }

        await prisma.newsletterSubscriber.upsert({
          where: { email: body.email },
          // Re-subscribing clears a previous opt-out.
          update: { unsubscribedAt: null, source: body.source },
          create: {
            email: body.email,
            source: body.source,
            ipAddress: request.ip
          }
        });

        // Deliberately identical whether or not the address was already on the
        // list, so the endpoint cannot be used to test for subscribers.
        return reply.code(201).send({ ok: true, message: "You're on the list. Watch your inbox." });
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );

  /**
   * The assistant for visitors who are not signed in — the floating chat bubble
   * on the marketing pages, the login screen, and signup.
   *
   * Deliberately stateless: an anonymous visitor has no organization or user row
   * to hang an AiThread off, so the client replays the last few turns and nothing
   * is persisted. That also means there is no per-user quota to enforce here, so
   * the IP rate limit is the only thing standing between this route and the
   * provider bill — keep it tight.
   */
  app.post(
    "/public/ai/chat",
    { config: { rateLimit: { max: 12, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      try {
        const body = guestChatSchema.parse(request.body);

        const setting = await getAiSetting();
        if (!setting?.enabled || !setting.encryptedApiKey) {
          return reply.code(503).send({
            error: "ai_disabled",
            message: "The assistant is not available right now."
          });
        }

        const messages: AiChatMessage[] = [
          ...body.history.slice(-GUEST_CONTEXT_LIMIT),
          { role: "user" as const, content: body.message }
        ];

        try {
          const completion = await createAiCompletion({
            messages,
            masterEncryptionKey: config.masterEncryptionKey,
            systemPrompt: `${setting.systemPrompt || DEFAULT_SYSTEM_PROMPT}${GUEST_PROMPT_SUFFIX}`,
            // Guests get shorter answers: it caps cost on an unauthenticated
            // route and long essays do not belong in a 380px chat panel.
            maxOutputTokens: Math.min(setting.maxOutputTokens, 700)
          });

          return { reply: completion.content };
        } catch (error) {
          request.log.error({ err: error }, "guest AI completion failed");

          if (error instanceof AiConfigurationError) {
            return reply.code(503).send({
              error: error.code,
              message: "The assistant is not available right now."
            });
          }
          if (error instanceof AiUpstreamError) {
            const status = error.status === 429 ? 429 : 502;
            return reply.code(status).send({
              error: status === 429 ? "ai_rate_limited" : "ai_upstream_error",
              message:
                status === 429
                  ? "Lots of questions right now — try again in a moment."
                  : "Could not answer that. Try again in a moment."
            });
          }

          return reply.code(502).send({
            error: "ai_upstream_error",
            message: "The assistant is temporarily unavailable."
          });
        }
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );
}
