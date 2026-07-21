import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canManagePlatform, normalizeSlug, validatePassword } from "@onshell/shared";
import prismaPkg, { type Prisma } from "@prisma/client";
const { PaymentProvider, Role, SubscriptionStatus, BillingInterval } = prismaPkg;
type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];
import bcrypt from "bcryptjs";
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

const publicRoleEnum = z.enum(["owner", "admin", "devops", "developer", "auditor"]);

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: publicRoleEnum.default("owner"),
  isPlatformAdmin: z.boolean().default(false),
  password: z.string().optional(),
  sendInvite: z.boolean().default(false)
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  role: publicRoleEnum.optional(),
  isPlatformAdmin: z.boolean().optional(),
  emailVerified: z.boolean().optional()
});

const setPasswordSchema = z.object({
  password: z.string().min(1)
});

const assignPlanSchema = z.object({
  planId: z.string().min(1),
  billingInterval: z.enum(["monthly", "yearly"]).default("monthly")
});

const roleToPrisma = {
  owner: Role.OWNER,
  admin: Role.ADMIN,
  devops: Role.DEVOPS,
  developer: Role.DEVELOPER,
  auditor: Role.AUDITOR
} satisfies Record<z.infer<typeof publicRoleEnum>, (typeof Role)[keyof typeof Role]>;

async function uniqueOrganizationSlug(name: string) {
  const base = normalizeSlug(name) || "org";
  let slug = base;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await prisma.organization.findUnique({ where: { slug } });
    if (!existing) return slug;
    slug = `${base}-${randomUUID().slice(0, 6)}`;
  }
  return `${base}-${randomUUID().slice(0, 12)}`;
}

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

    const trendDays = 30;
    const trendStart = new Date();
    trendStart.setHours(0, 0, 0, 0);
    trendStart.setDate(trendStart.getDate() - (trendDays - 1));

    const [
      users,
      organizations,
      hosts,
      activeSubscriptions,
      plans,
      smtp,
      paymentProviders,
      usersBeforeWindow,
      recentUsers,
      recentHosts,
      activeSubs
    ] = await Promise.all([
      prisma.user.count(),
      prisma.organization.count(),
      prisma.host.count(),
      prisma.subscription.count({ where: { status: "ACTIVE" } }),
      prisma.plan.count(),
      prisma.smtpSetting.findUnique({ where: { id: "global" } }),
      prisma.paymentSetting.findMany(),
      prisma.user.count({ where: { createdAt: { lt: trendStart } } }),
      prisma.user.findMany({ where: { createdAt: { gte: trendStart } }, select: { createdAt: true } }),
      prisma.host.findMany({ where: { createdAt: { gte: trendStart } }, select: { createdAt: true } }),
      prisma.subscription.findMany({ where: { status: "ACTIVE" }, select: { plan: { select: { name: true } } } })
    ]);

    const dayKey = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    const bucketDaily = (rows: Array<{ createdAt: Date }>) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = dayKey(row.createdAt);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const out: Array<{ date: string; count: number }> = [];
      for (let index = 0; index < trendDays; index += 1) {
        const date = new Date(trendStart);
        date.setDate(trendStart.getDate() + index);
        const key = dayKey(date);
        out.push({ date: key, count: counts.get(key) ?? 0 });
      }
      return out;
    };

    const dailyUsers = bucketDaily(recentUsers);
    const dailyHosts = bucketDaily(recentHosts);

    /* cumulative user total across the window, seeded by everyone before it */
    let runningUsers = usersBeforeWindow;
    const cumulativeUsers = dailyUsers.map((point) => {
      runningUsers += point.count;
      return { date: point.date, count: runningUsers };
    });

    const planCounts = new Map<string, number>();
    for (const sub of activeSubs) {
      const name = sub.plan?.name ?? "Unknown";
      planCounts.set(name, (planCounts.get(name) ?? 0) + 1);
    }
    const planBreakdown = Array.from(planCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count);

    return {
      totals: {
        users,
        organizations,
        hosts,
        activeSubscriptions,
        plans
      },
      series: {
        days: trendDays,
        users: dailyUsers,
        hosts: dailyHosts,
        cumulativeUsers
      },
      breakdown: {
        plans: planBreakdown
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
      include: { memberships: { include: { organization: true } } },
      orderBy: { createdAt: "desc" }
    });

    return users.map((user) => ({
      ...toPublicUser(user),
      organizationName: user.memberships[0]?.organization?.name ?? null
    }));
  });

  app.post("/admin/users", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const body = createUserSchema.parse(request.body);
      const email = body.email.trim().toLowerCase();

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return reply.code(409).send({ error: "email_already_registered" });

      let passwordHash: string | null = null;
      if (!body.sendInvite) {
        if (!body.password) return reply.code(400).send({ error: "password_required" });
        const passwordCheck = validatePassword(body.password);
        if (!passwordCheck.valid) {
          return reply.code(400).send({ error: "password_policy_violation", errors: passwordCheck.errors });
        }
        passwordHash = await bcrypt.hash(body.password, 12);
      }

      const slug = await uniqueOrganizationSlug(body.name);
      const prismaUser = await prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name: `${body.name}'s Organization`, slug }
        });
        return tx.user.create({
          data: {
            name: body.name,
            email,
            passwordHash,
            isPlatformAdmin: body.isPlatformAdmin,
            memberships: {
              create: { organizationId: organization.id, role: roleToPrisma[body.role] }
            }
          },
          include: { memberships: true }
        });
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.user.create",
        targetType: "user",
        targetId: prismaUser.id,
        ipAddress: request.ip,
        metadata: { email, role: body.role, isPlatformAdmin: body.isPlatformAdmin, invited: body.sendInvite }
      });

      return reply.code(201).send(toPublicUser(prismaUser));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/admin/users/:userId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { userId } = z.object({ userId: z.string() }).parse(request.params);
      const body = updateUserSchema.parse(request.body);

      const target = await prisma.user.findUnique({ where: { id: userId }, include: { memberships: true } });
      if (!target) return reply.code(404).send({ error: "user_not_found" });

      if (userId === actor.id && body.isPlatformAdmin === false) {
        return reply.code(400).send({ error: "cannot_demote_self" });
      }

      const data: Prisma.UserUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.isPlatformAdmin !== undefined) data.isPlatformAdmin = body.isPlatformAdmin;
      if (body.emailVerified !== undefined) data.emailVerifiedAt = body.emailVerified ? new Date() : null;

      if (body.role !== undefined) {
        const membership = target.memberships[0];
        if (membership) {
          await prisma.organizationMember.update({
            where: { id: membership.id },
            data: { role: roleToPrisma[body.role] }
          });
        }
      }

      const updated = await prisma.user.update({
        where: { id: userId },
        data,
        include: { memberships: true }
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.user.update",
        targetType: "user",
        targetId: userId,
        ipAddress: request.ip,
        metadata: {
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.isPlatformAdmin !== undefined ? { isPlatformAdmin: body.isPlatformAdmin } : {}),
          ...(body.emailVerified !== undefined ? { emailVerified: body.emailVerified } : {}),
          ...(body.name !== undefined ? { renamed: true } : {})
        }
      });

      return toPublicUser(updated);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/admin/users/:userId/password", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { userId } = z.object({ userId: z.string() }).parse(request.params);
      const body = setPasswordSchema.parse(request.body);

      const target = await prisma.user.findUnique({ where: { id: userId } });
      if (!target) return reply.code(404).send({ error: "user_not_found" });

      const passwordCheck = validatePassword(body.password);
      if (!passwordCheck.valid) {
        return reply.code(400).send({ error: "password_policy_violation", errors: passwordCheck.errors });
      }

      const passwordHash = await bcrypt.hash(body.password, 12);
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
        prisma.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() }
        })
      ]);

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.user.password.set",
        targetType: "user",
        targetId: userId,
        ipAddress: request.ip
      });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/admin/users/:userId/plan", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { userId } = z.object({ userId: z.string() }).parse(request.params);
      const body = assignPlanSchema.parse(request.body);

      const target = await prisma.user.findUnique({ where: { id: userId }, include: { memberships: true } });
      if (!target) return reply.code(404).send({ error: "user_not_found" });

      const organizationId = target.memberships[0]?.organizationId;
      if (!organizationId) return reply.code(400).send({ error: "user_has_no_organization" });

      const plan = await prisma.plan.findUnique({ where: { id: body.planId } });
      if (!plan) return reply.code(404).send({ error: "plan_not_found" });

      const interval = body.billingInterval === "yearly" ? BillingInterval.YEARLY : BillingInterval.MONTHLY;
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      if (body.billingInterval === "yearly") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      else periodEnd.setMonth(periodEnd.getMonth() + 1);

      const existing = await prisma.subscription.findFirst({
        where: { organizationId },
        orderBy: { createdAt: "desc" }
      });

      const subscription = existing
        ? await prisma.subscription.update({
            where: { id: existing.id },
            data: {
              planId: plan.id,
              billingInterval: interval,
              status: SubscriptionStatus.ACTIVE,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
              cancelAt: null
            },
            include: { organization: true, plan: true, invoices: { orderBy: { createdAt: "desc" }, take: 5 } }
          })
        : await prisma.subscription.create({
            data: {
              organizationId,
              planId: plan.id,
              billingInterval: interval,
              status: SubscriptionStatus.ACTIVE,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd
            },
            include: { organization: true, plan: true, invoices: { orderBy: { createdAt: "desc" }, take: 5 } }
          });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.user.plan.assign",
        targetType: "subscription",
        targetId: subscription.id,
        ipAddress: request.ip,
        metadata: { userId, organizationId, planCode: plan.code, billingInterval: body.billingInterval }
      });

      return subscription;
    } catch (error) {
      return handleRouteError(reply, error);
    }
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
