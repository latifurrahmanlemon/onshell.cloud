import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { z } from "zod";
import { getPublicAiConfig } from "../../lib/ai.js";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { sendTransactionalEmail } from "../../lib/email.js";
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

const newsletterSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.trim().toLowerCase()),
  source: z.string().trim().max(60).default("footer"),
  turnstileToken: z.string().optional()
});

/** Escapes user text before it is interpolated into the notification email. */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function registerPublicRoutes(app: FastifyInstance, config: RuntimeConfig) {
  /**
   * Runtime configuration the public site needs before rendering its forms.
   * Served from the API rather than baked into the bundle so an admin can rotate
   * the Turnstile site key or toggle the AI assistant without a rebuild.
   */
  app.get("/public/site-config", async () => {
    const [turnstile, ai] = await Promise.all([getPublicTurnstileConfig(), getPublicAiConfig()]);

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
        void sendTransactionalEmail({
          masterEncryptionKey: config.masterEncryptionKey,
          recipient: notifyEmail,
          subject: `[Onshell.cloud] ${body.topic} enquiry from ${body.name}`,
          text: [
            `Topic: ${body.topic}`,
            `Name: ${body.name}`,
            `Email: ${body.email}`,
            body.company ? `Company: ${body.company}` : undefined,
            "",
            body.message,
            "",
            `Open in admin: ${config.siteUrl}/admin?section=inbox&message=${created.id}`
          ]
            .filter(Boolean)
            .join("\n"),
          html: [
            `<p><strong>Topic:</strong> ${escapeHtml(body.topic)}</p>`,
            `<p><strong>Name:</strong> ${escapeHtml(body.name)}<br/>`,
            `<strong>Email:</strong> ${escapeHtml(body.email)}`,
            body.company ? `<br/><strong>Company:</strong> ${escapeHtml(body.company)}` : "",
            "</p>",
            `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(body.message)}</pre>`,
            `<p><a href="${config.siteUrl}/admin?section=inbox&message=${created.id}">Open in the admin inbox</a></p>`
          ].join(""),
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
}
