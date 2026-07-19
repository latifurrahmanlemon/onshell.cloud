import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canManagePlatform } from "@onshell/shared";
import prismaPkg, { type Prisma } from "@prisma/client";
const { PaymentProvider } = prismaPkg;
type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { encryptSecret } from "../../lib/encryption.js";
import { sendSmtpTestEmail } from "../../lib/email.js";
import { prisma } from "../../lib/prisma.js";
import { toPublicUser } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

const planSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  description: z.string().min(10),
  priceMonthlyCents: z.number().int().min(0),
  priceYearlyCents: z.number().int().min(0),
  currency: z.string().min(3).max(3).default("USD"),
  maxUsers: z.number().int().positive().nullable().optional(),
  maxHosts: z.number().int().positive().nullable().optional(),
  maxConcurrentSessions: z.number().int().positive().nullable().optional(),
  auditRetentionDays: z.number().int().positive(),
  features: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().default(0)
});

const smtpSchema = z.object({
  host: z.string().min(2),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().optional(),
  password: z.string().optional(),
  fromEmail: z.string().email(),
  fromName: z.string().min(2),
  enabled: z.boolean(),
  testRecipient: z.string().email().optional()
});

const appSettingSchema = z.object({
  key: z.string().min(2),
  category: z.string().min(2).default("platform"),
  value: z.unknown(),
  isSecret: z.boolean().default(false)
});

const paymentSettingSchema = z.object({
  provider: z.enum(["stripe", "paddle", "ssl_commerz", "manual"]),
  mode: z.enum(["test", "live"]).default("test"),
  publicKey: z.string().optional(),
  secretKey: z.string().optional(),
  webhookSecret: z.string().optional(),
  enabled: z.boolean()
});

const smtpTestSchema = z.object({
  recipient: z.string().email()
});

function toPrismaPaymentProvider(provider: z.infer<typeof paymentSettingSchema>["provider"]) {
  const map = {
    stripe: PaymentProvider.STRIPE,
    paddle: PaymentProvider.PADDLE,
    ssl_commerz: PaymentProvider.SSL_COMMERZ,
    manual: PaymentProvider.MANUAL
  } satisfies Record<z.infer<typeof paymentSettingSchema>["provider"], PaymentProvider>;

  return map[provider];
}

function toPublicPlan(plan: {
  features: unknown;
  [key: string]: unknown;
}) {
  return {
    ...plan,
    features: Array.isArray(plan.features) ? plan.features : []
  };
}

async function requirePlatformAdmin(request: FastifyRequest, config: RuntimeConfig) {
  const actor = await getAuthenticatedUser(request, config);
  return actor && canManagePlatform(actor) ? actor : undefined;
}

async function createAudit(input: {
  organizationId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      ...input,
      metadata: input.metadata as Prisma.InputJsonValue | undefined
    }
  });
}

export async function registerAdminRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/admin/overview", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    const [users, organizations, hosts, activeSubscriptions, plans, smtp, paymentProviders] = await Promise.all([
      prisma.user.count(),
      prisma.organization.count(),
      prisma.host.count(),
      prisma.subscription.count({ where: { status: "ACTIVE" } }),
      prisma.plan.count(),
      prisma.smtpSetting.findUnique({ where: { id: "global" } }),
      prisma.paymentSetting.findMany()
    ]);

    return {
      totals: {
        users,
        organizations,
        hosts,
        activeSubscriptions,
        plans
      },
      smtp: smtp
        ? {
            enabled: smtp.enabled,
            host: smtp.host,
            fromEmail: smtp.fromEmail
          }
        : undefined,
      paymentProviders: paymentProviders.map((provider) => ({
        id: provider.id,
        provider: provider.provider,
        mode: provider.mode,
        publicKey: provider.publicKey,
        enabled: provider.enabled,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt
      }))
    };
  });

  app.get("/admin/users", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    const users = await prisma.user.findMany({
      include: { memberships: true },
      orderBy: { createdAt: "desc" }
    });

    return users.map(toPublicUser);
  });

  app.get("/admin/plans", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    const plans = await prisma.plan.findMany({
      orderBy: { displayOrder: "asc" }
    });

    return plans.map(toPublicPlan);
  });

  app.post("/admin/plans", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const body = planSchema.parse(request.body);
      const plan = await prisma.plan.create({
        data: body
      });
      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.plan.create",
        targetType: "plan",
        targetId: plan.id,
        ipAddress: request.ip,
        metadata: { code: plan.code }
      });

      return reply.code(201).send(toPublicPlan(plan));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/admin/plans/:planId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { planId } = z.object({ planId: z.string() }).parse(request.params);
      const body = planSchema.partial().parse(request.body);
      const plan = await prisma.plan.update({
        where: { id: planId },
        data: body
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.plan.update",
        targetType: "plan",
        targetId: plan.id,
        ipAddress: request.ip
      });

      return toPublicPlan(plan);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/subscriptions", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    return prisma.subscription.findMany({
      include: {
        organization: true,
        plan: true,
        invoices: {
          orderBy: { createdAt: "desc" },
          take: 5
        }
      },
      orderBy: { createdAt: "desc" }
    });
  });

  app.get("/admin/smtp", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    const smtp = await prisma.smtpSetting.findUnique({ where: { id: "global" } });
    if (!smtp) return reply.code(404).send({ error: "smtp_settings_not_found" });

    return {
      id: smtp.id,
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      fromEmail: smtp.fromEmail,
      fromName: smtp.fromName,
      enabled: smtp.enabled,
      testRecipient: smtp.testRecipient,
      hasPassword: Boolean(smtp.encryptedPassword),
      updatedAt: smtp.updatedAt
    };
  });

  app.patch("/admin/smtp", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const body = smtpSchema.parse(request.body);
      const encrypted = body.password ? encryptSecret(body.password, config.masterEncryptionKey) : undefined;
      const smtp = await prisma.smtpSetting.upsert({
        where: { id: "global" },
        update: {
          host: body.host,
          port: body.port,
          secure: body.secure,
          username: body.username,
          fromEmail: body.fromEmail,
          fromName: body.fromName,
          enabled: body.enabled,
          testRecipient: body.testRecipient,
          updatedById: actor.id,
          ...(encrypted
            ? {
                encryptedPassword: encrypted.encryptedPayload,
                passwordNonce: encrypted.nonce,
                passwordAuthTag: encrypted.authTag
              }
            : {})
        },
        create: {
          id: "global",
          host: body.host,
          port: body.port,
          secure: body.secure,
          username: body.username,
          fromEmail: body.fromEmail,
          fromName: body.fromName,
          enabled: body.enabled,
          testRecipient: body.testRecipient,
          updatedById: actor.id,
          encryptedPassword: encrypted?.encryptedPayload,
          passwordNonce: encrypted?.nonce,
          passwordAuthTag: encrypted?.authTag
        }
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.smtp.update",
        targetType: "smtp_settings",
        ipAddress: request.ip,
        metadata: { host: body.host, enabled: body.enabled, passwordProvided: Boolean(body.password) }
      });

      return {
        id: smtp.id,
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        username: smtp.username,
        fromEmail: smtp.fromEmail,
        fromName: smtp.fromName,
        enabled: smtp.enabled,
        testRecipient: smtp.testRecipient,
        hasPassword: Boolean(smtp.encryptedPassword),
        updatedAt: smtp.updatedAt
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/admin/smtp/test", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const body = smtpTestSchema.parse(request.body);
      const smtp = await prisma.smtpSetting.findUnique({ where: { id: "global" } });
      if (!smtp) return reply.code(404).send({ error: "smtp_settings_not_found" });

      const result = await sendSmtpTestEmail({
        smtp,
        masterEncryptionKey: config.masterEncryptionKey,
        recipient: body.recipient
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.smtp.test",
        targetType: "smtp_settings",
        ipAddress: request.ip,
        metadata: { recipient: body.recipient, messageId: result.messageId }
      });

      return result;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/settings", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    return prisma.appSetting.findMany({
      orderBy: [{ category: "asc" }, { key: "asc" }]
    });
  });

  app.patch("/admin/settings", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const body = appSettingSchema.parse(request.body);
      const setting = await prisma.appSetting.upsert({
        where: { key: body.key },
        update: {
          category: body.category,
          value: body.value as never,
          isSecret: body.isSecret,
          updatedById: actor.id
        },
        create: {
          key: body.key,
          category: body.category,
          value: body.value as never,
          isSecret: body.isSecret,
          updatedById: actor.id
        }
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.setting.update",
        targetType: "app_setting",
        targetId: body.key,
        ipAddress: request.ip
      });

      return setting;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/payment-settings", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    const settings = await prisma.paymentSetting.findMany({
      orderBy: [{ provider: "asc" }, { mode: "asc" }]
    });

    return settings.map((setting) => ({
      id: setting.id,
      provider: setting.provider,
      mode: setting.mode,
      publicKey: setting.publicKey,
      enabled: setting.enabled,
      hasSecretKey: Boolean(setting.encryptedSecretKey),
      hasWebhookSecret: Boolean(setting.encryptedWebhookSecret),
      updatedAt: setting.updatedAt
    }));
  });

  app.patch("/admin/payment-settings", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const body = paymentSettingSchema.parse(request.body);
      const encryptedSecretKey = body.secretKey ? encryptSecret(body.secretKey, config.masterEncryptionKey) : undefined;
      const encryptedWebhookSecret = body.webhookSecret ? encryptSecret(body.webhookSecret, config.masterEncryptionKey) : undefined;
      const setting = await prisma.paymentSetting.upsert({
        where: {
          provider_mode: {
            provider: toPrismaPaymentProvider(body.provider),
            mode: body.mode
          }
        },
        update: {
          publicKey: body.publicKey,
          enabled: body.enabled,
          ...(encryptedSecretKey
            ? {
                encryptedSecretKey: encryptedSecretKey.encryptedPayload,
                secretKeyNonce: encryptedSecretKey.nonce,
                secretKeyAuthTag: encryptedSecretKey.authTag
              }
            : {}),
          ...(encryptedWebhookSecret
            ? {
                encryptedWebhookSecret: encryptedWebhookSecret.encryptedPayload,
                webhookSecretNonce: encryptedWebhookSecret.nonce,
                webhookSecretAuthTag: encryptedWebhookSecret.authTag
              }
            : {})
        },
        create: {
          provider: toPrismaPaymentProvider(body.provider),
          mode: body.mode,
          publicKey: body.publicKey,
          enabled: body.enabled,
          encryptedSecretKey: encryptedSecretKey?.encryptedPayload,
          secretKeyNonce: encryptedSecretKey?.nonce,
          secretKeyAuthTag: encryptedSecretKey?.authTag,
          encryptedWebhookSecret: encryptedWebhookSecret?.encryptedPayload,
          webhookSecretNonce: encryptedWebhookSecret?.nonce,
          webhookSecretAuthTag: encryptedWebhookSecret?.authTag
        }
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.payment.update",
        targetType: "payment_setting",
        targetId: setting.id,
        ipAddress: request.ip,
        metadata: { provider: setting.provider, mode: setting.mode, enabled: setting.enabled }
      });

      return {
        id: setting.id,
        provider: setting.provider,
        mode: setting.mode,
        publicKey: setting.publicKey,
        enabled: setting.enabled,
        hasSecretKey: Boolean(setting.encryptedSecretKey),
        hasWebhookSecret: Boolean(setting.encryptedWebhookSecret),
        updatedAt: setting.updatedAt
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
