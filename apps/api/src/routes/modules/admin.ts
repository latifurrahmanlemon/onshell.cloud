import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canManagePlatform, normalizeSlug, validatePassword } from "@onshell/shared";
import prismaPkg, { type Prisma } from "@prisma/client";
const { PaymentProvider, Role, SubscriptionStatus, BillingInterval } = prismaPkg;
type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  AiConfigurationError,
  AiUpstreamError,
  createAiCompletion,
  DEFAULT_SYSTEM_PROMPT
} from "../../lib/ai.js";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { encryptSecret } from "../../lib/encryption.js";
import { describeSmtpFailure, sendSmtpTestEmail } from "../../lib/email.js";
import { prisma } from "../../lib/prisma.js";
import { toPublicUser } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

const planSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, "Plan codes are lowercase letters, digits, hyphens, and underscores."),
  name: z.string().min(2).max(60),
  description: z.string().min(10).max(600),
  tagline: z.string().max(120).nullable().optional(),
  badge: z.string().max(40).nullable().optional(),
  priceMonthlyCents: z.number().int().min(0),
  priceYearlyCents: z.number().int().min(0),
  currency: z.string().min(3).max(3).default("USD"),
  maxUsers: z.number().int().positive().nullable().optional(),
  maxHosts: z.number().int().positive().nullable().optional(),
  maxConcurrentSessions: z.number().int().positive().nullable().optional(),
  auditRetentionDays: z.number().int().positive(),
  monthlyAiMessages: z.number().int().min(0).nullable().optional(),
  features: z.array(z.string().max(120)).max(20).default([]),
  isActive: z.boolean().default(true),
  isFree: z.boolean().default(false),
  isFeatured: z.boolean().default(false),
  trialDays: z.number().int().min(0).max(90).default(0),
  displayOrder: z.number().int().default(0)
});

/**
 * `code` is the stable identifier the public pricing page and checkout resolve
 * against, so it is fixed after creation — renaming it would silently break
 * every existing checkout link.
 */
const planUpdateSchema = planSchema.omit({ code: true }).partial();

const turnstileSchema = z.object({
  siteKey: z.string().trim().max(120).optional(),
  /** Omit to keep the stored secret; send a value to rotate it. */
  secretKey: z.string().trim().max(200).optional(),
  enabled: z.boolean(),
  protectSignup: z.boolean().default(true),
  protectLogin: z.boolean().default(true),
  protectPasswordReset: z.boolean().default(true),
  protectContact: z.boolean().default(true),
  protectCheckout: z.boolean().default(true),
  protectNewsletter: z.boolean().default(true)
});

const aiSettingSchema = z.object({
  model: z.string().trim().min(2).max(80),
  /** Omit to keep the stored key; send a value to rotate it. */
  apiKey: z.string().trim().max(300).optional(),
  baseUrl: z.string().trim().url().max(300).nullable().optional(),
  systemPrompt: z.string().trim().min(20).max(8_000),
  /** Integer percentage (0-200) so the column stays an Int; 20 means 0.2. */
  temperature: z.number().int().min(0).max(200),
  maxOutputTokens: z.number().int().min(128).max(8_000),
  monthlyMessageCap: z.number().int().min(0).max(100_000),
  enabled: z.boolean()
});

const contactStatusEnum = z.enum(["NEW", "OPEN", "RESOLVED", "SPAM"]);

const contactUpdateSchema = z.object({
  status: contactStatusEnum.optional(),
  adminNotes: z.string().max(5_000).nullable().optional()
});

const contactListSchema = z.object({
  status: contactStatusEnum.optional(),
  search: z.string().trim().max(120).optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0)
});

const aiThreadListSchema = z.object({
  search: z.string().trim().max(120).optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0)
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
      const body = planUpdateSchema.parse(request.body);
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

      // Enabling with a username but no password produces a transport that
      // authenticates with `pass: undefined`. Most providers reject that, and the
      // only symptom is invitations and reset codes silently never arriving — so
      // fail here, where the admin can actually see why.
      const existingSmtp = await prisma.smtpSetting.findUnique({ where: { id: "global" } });
      const willHavePassword = Boolean(encrypted ?? existingSmtp?.encryptedPassword);
      if (body.enabled && body.username && !willHavePassword) {
        return reply.code(400).send({
          error: "smtp_password_required",
          message:
            "This SMTP user has no password stored. Enter the password before enabling delivery, or clear the username if your relay does not require authentication."
        });
      }

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

      let result: Awaited<ReturnType<typeof sendSmtpTestEmail>>;
      try {
        result = await sendSmtpTestEmail({
          smtp,
          masterEncryptionKey: config.masterEncryptionKey,
          recipient: body.recipient
        });
      } catch (sendError) {
        // A refused or misconfigured mail server is not an internal error, and
        // this button's whole purpose is to say what went wrong — falling through
        // to handleRouteError would answer a diagnostic with "internal_error".
        const failure = describeSmtpFailure(sendError);
        request.log.error({ err: sendError, recipient: body.recipient }, "SMTP test send failed");

        await createAudit({
          organizationId: actor.organizationId,
          actorId: actor.id,
          action: "admin.smtp.test.failed",
          targetType: "smtp_settings",
          ipAddress: request.ip,
          metadata: { recipient: body.recipient, code: failure.code ?? null, responseCode: failure.responseCode ?? null }
        });

        return reply.code(failure.kind === "config" ? 400 : 502).send({
          error: "smtp_test_failed",
          message: failure.detail ? `${failure.message} (${failure.detail})` : failure.message,
          code: failure.code,
          responseCode: failure.responseCode
        });
      }

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

  // ---------------------------------------------------------------------------
  // Bot protection (Cloudflare Turnstile)
  // ---------------------------------------------------------------------------

  app.get("/admin/turnstile", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    const setting = await prisma.turnstileSetting.findUnique({ where: { id: "global" } });

    // The secret key is never returned — only whether one is stored.
    return {
      siteKey: setting?.siteKey ?? "",
      hasSecretKey: Boolean(setting?.encryptedSecretKey),
      enabled: setting?.enabled ?? false,
      protectSignup: setting?.protectSignup ?? true,
      protectLogin: setting?.protectLogin ?? true,
      protectPasswordReset: setting?.protectPasswordReset ?? true,
      protectContact: setting?.protectContact ?? true,
      protectCheckout: setting?.protectCheckout ?? true,
      protectNewsletter: setting?.protectNewsletter ?? true,
      updatedAt: setting?.updatedAt ?? null
    };
  });

  app.patch("/admin/turnstile", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const body = turnstileSchema.parse(request.body);
      const existing = await prisma.turnstileSetting.findUnique({ where: { id: "global" } });
      const encrypted = body.secretKey ? encryptSecret(body.secretKey, config.masterEncryptionKey) : undefined;

      // Enabling without a usable key pair would fail every public form closed,
      // so reject the combination instead of locking signups out.
      const willHaveSecret = Boolean(encrypted ?? existing?.encryptedSecretKey);
      const willHaveSiteKey = Boolean(body.siteKey ?? existing?.siteKey);
      if (body.enabled && (!willHaveSecret || !willHaveSiteKey)) {
        return reply.code(400).send({
          error: "turnstile_incomplete",
          message: "Add both the site key and the secret key before enabling bot protection."
        });
      }

      const shared = {
        siteKey: body.siteKey ?? existing?.siteKey ?? null,
        enabled: body.enabled,
        protectSignup: body.protectSignup,
        protectLogin: body.protectLogin,
        protectPasswordReset: body.protectPasswordReset,
        protectContact: body.protectContact,
        protectCheckout: body.protectCheckout,
        protectNewsletter: body.protectNewsletter,
        updatedById: actor.id,
        ...(encrypted
          ? {
              encryptedSecretKey: encrypted.encryptedPayload,
              secretKeyNonce: encrypted.nonce,
              secretKeyAuthTag: encrypted.authTag
            }
          : {})
      };

      const setting = await prisma.turnstileSetting.upsert({
        where: { id: "global" },
        update: shared,
        create: { id: "global", ...shared }
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.turnstile.update",
        targetType: "turnstile_settings",
        ipAddress: request.ip,
        metadata: { enabled: setting.enabled, secretRotated: Boolean(body.secretKey) }
      });

      return {
        siteKey: setting.siteKey ?? "",
        hasSecretKey: Boolean(setting.encryptedSecretKey),
        enabled: setting.enabled,
        protectSignup: setting.protectSignup,
        protectLogin: setting.protectLogin,
        protectPasswordReset: setting.protectPasswordReset,
        protectContact: setting.protectContact,
        protectCheckout: setting.protectCheckout,
        protectNewsletter: setting.protectNewsletter,
        updatedAt: setting.updatedAt
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  // ---------------------------------------------------------------------------
  // AI assistant configuration
  // ---------------------------------------------------------------------------

  app.get("/admin/ai/settings", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    const setting = await prisma.aiSetting.findUnique({ where: { id: "global" } });

    return {
      provider: setting?.provider ?? "openai",
      model: setting?.model ?? "gpt-4o-mini",
      hasApiKey: Boolean(setting?.encryptedApiKey),
      baseUrl: setting?.baseUrl ?? "",
      systemPrompt: setting?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      temperature: setting?.temperature ?? 20,
      maxOutputTokens: setting?.maxOutputTokens ?? 900,
      monthlyMessageCap: setting?.monthlyMessageCap ?? 100,
      enabled: setting?.enabled ?? false,
      updatedAt: setting?.updatedAt ?? null
    };
  });

  app.patch("/admin/ai/settings", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const body = aiSettingSchema.parse(request.body);
      const existing = await prisma.aiSetting.findUnique({ where: { id: "global" } });
      const encrypted = body.apiKey ? encryptSecret(body.apiKey, config.masterEncryptionKey) : undefined;

      if (body.enabled && !(encrypted ?? existing?.encryptedApiKey)) {
        return reply.code(400).send({
          error: "ai_key_missing",
          message: "Add an API key before enabling the AI assistant."
        });
      }

      const shared = {
        provider: "openai",
        model: body.model,
        baseUrl: body.baseUrl ?? null,
        systemPrompt: body.systemPrompt,
        temperature: body.temperature,
        maxOutputTokens: body.maxOutputTokens,
        monthlyMessageCap: body.monthlyMessageCap,
        enabled: body.enabled,
        updatedById: actor.id,
        ...(encrypted
          ? {
              encryptedApiKey: encrypted.encryptedPayload,
              apiKeyNonce: encrypted.nonce,
              apiKeyAuthTag: encrypted.authTag
            }
          : {})
      };

      const setting = await prisma.aiSetting.upsert({
        where: { id: "global" },
        update: shared,
        create: { id: "global", ...shared }
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.ai.update",
        targetType: "ai_settings",
        ipAddress: request.ip,
        metadata: { enabled: setting.enabled, model: setting.model, keyRotated: Boolean(body.apiKey) }
      });

      return {
        provider: setting.provider,
        model: setting.model,
        hasApiKey: Boolean(setting.encryptedApiKey),
        baseUrl: setting.baseUrl ?? "",
        systemPrompt: setting.systemPrompt,
        temperature: setting.temperature,
        maxOutputTokens: setting.maxOutputTokens,
        monthlyMessageCap: setting.monthlyMessageCap,
        enabled: setting.enabled,
        updatedAt: setting.updatedAt
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /** Sends a fixed prompt through the live configuration to prove the key works. */
  app.post("/admin/ai/test", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const completion = await createAiCompletion({
        messages: [{ role: "user", content: "Reply with exactly: Onshell AI is connected." }],
        masterEncryptionKey: config.masterEncryptionKey,
        maxOutputTokens: 64
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.ai.test",
        targetType: "ai_settings",
        ipAddress: request.ip,
        metadata: { model: completion.model }
      });

      return { ok: true, model: completion.model, reply: completion.content };
    } catch (error) {
      if (error instanceof AiConfigurationError) {
        return reply.code(400).send({ error: error.code, message: error.message });
      }
      if (error instanceof AiUpstreamError) {
        return reply.code(502).send({
          error: "ai_upstream_error",
          message: `The AI provider rejected the request (HTTP ${error.status}). Check the API key and model name.`
        });
      }
      return handleRouteError(reply, error);
    }
  });

  /** Every AI conversation on the platform, for support and abuse review. */
  app.get("/admin/ai/threads", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const query = aiThreadListSchema.parse(request.query);
      const where: Prisma.AiThreadWhereInput = query.search
        ? {
            OR: [
              { title: { contains: query.search } },
              { user: { email: { contains: query.search } } },
              { user: { name: { contains: query.search } } }
            ]
          }
        : {};

      const [total, threads] = await Promise.all([
        prisma.aiThread.count({ where }),
        prisma.aiThread.findMany({
          where,
          orderBy: { lastMessageAt: "desc" },
          take: query.take,
          skip: query.skip,
          select: {
            id: true,
            title: true,
            messageCount: true,
            lastMessageAt: true,
            createdAt: true,
            user: { select: { id: true, name: true, email: true, avatarUrl: true } },
            organization: { select: { id: true, name: true } }
          }
        })
      ]);

      return { total, take: query.take, skip: query.skip, threads };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/admin/ai/threads/:threadId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { threadId } = z.object({ threadId: z.string() }).parse(request.params);
      const thread = await prisma.aiThread.findUnique({
        where: { id: threadId },
        include: {
          user: { select: { id: true, name: true, email: true, avatarUrl: true } },
          organization: { select: { id: true, name: true } },
          messages: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              role: true,
              content: true,
              model: true,
              promptTokens: true,
              outputTokens: true,
              createdAt: true
            }
          }
        }
      });
      if (!thread) return reply.code(404).send({ error: "thread_not_found" });

      // Reading a user's conversation is a privileged action; record it.
      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.ai.thread.view",
        targetType: "ai_thread",
        targetId: thread.id,
        ipAddress: request.ip,
        metadata: { threadOwnerId: thread.userId }
      });

      return thread;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/admin/ai/threads/:threadId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { threadId } = z.object({ threadId: z.string() }).parse(request.params);

      // Read a little context before deleting so the audit entry is meaningful
      // once the row (and its messages, via cascade) is gone.
      const thread = await prisma.aiThread.findUnique({
        where: { id: threadId },
        select: { id: true, userId: true, title: true, messageCount: true }
      });
      if (!thread) return reply.code(404).send({ error: "thread_not_found" });

      await prisma.aiThread.delete({ where: { id: threadId } });

      // Deleting a user's conversation is a privileged, irreversible action.
      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.ai.thread.delete",
        targetType: "ai_thread",
        targetId: thread.id,
        ipAddress: request.ip,
        metadata: { threadOwnerId: thread.userId, title: thread.title, messageCount: thread.messageCount }
      });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Contact inbox
  // ---------------------------------------------------------------------------

  app.get("/admin/contact-messages", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const query = contactListSchema.parse(request.query);
      const where: Prisma.ContactMessageWhereInput = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search } },
                { email: { contains: query.search } },
                { company: { contains: query.search } },
                { message: { contains: query.search } }
              ]
            }
          : {})
      };

      const [total, unread, messages] = await Promise.all([
        prisma.contactMessage.count({ where }),
        prisma.contactMessage.count({ where: { status: "NEW" } }),
        prisma.contactMessage.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: query.take,
          skip: query.skip,
          include: { handledBy: { select: { id: true, name: true, email: true } } }
        })
      ]);

      return { total, unread, take: query.take, skip: query.skip, messages };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/admin/contact-messages/:messageId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { messageId } = z.object({ messageId: z.string() }).parse(request.params);
      const body = contactUpdateSchema.parse(request.body);
      if (body.status === undefined && body.adminNotes === undefined) {
        return reply.code(400).send({ error: "no_changes" });
      }

      const existing = await prisma.contactMessage.findUnique({ where: { id: messageId } });
      if (!existing) return reply.code(404).send({ error: "message_not_found" });

      const message = await prisma.contactMessage.update({
        where: { id: messageId },
        data: {
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.adminNotes !== undefined ? { adminNotes: body.adminNotes || null } : {}),
          // Stamp the first admin who moves it out of NEW as the handler.
          ...(body.status !== undefined && body.status !== "NEW"
            ? { handledById: actor.id, handledAt: new Date() }
            : {})
        },
        include: { handledBy: { select: { id: true, name: true, email: true } } }
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.contact.update",
        targetType: "contact_message",
        targetId: messageId,
        ipAddress: request.ip,
        metadata: { status: message.status }
      });

      return message;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/admin/contact-messages/:messageId", async (request, reply) => {
    try {
      const actor = await requirePlatformAdmin(request, config);
      if (!actor) return reply.code(403).send({ error: "forbidden" });

      const { messageId } = z.object({ messageId: z.string() }).parse(request.params);
      const deleted = await prisma.contactMessage.deleteMany({ where: { id: messageId } });
      if (deleted.count === 0) return reply.code(404).send({ error: "message_not_found" });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "admin.contact.delete",
        targetType: "contact_message",
        targetId: messageId,
        ipAddress: request.ip
      });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Growth / marketing
  // ---------------------------------------------------------------------------

  /** Newsletter list and referral leaderboard, for the marketing view. */
  app.get("/admin/growth", async (request, reply) => {
    const actor = await requirePlatformAdmin(request, config);
    if (!actor) return reply.code(403).send({ error: "forbidden" });

    const [subscriberCount, activeSubscribers, recentSubscribers, referrers, freeCount, paidCount] =
      await Promise.all([
        prisma.newsletterSubscriber.count(),
        prisma.newsletterSubscriber.count({ where: { unsubscribedAt: null } }),
        prisma.newsletterSubscriber.findMany({
          orderBy: { createdAt: "desc" },
          take: 25,
          select: { id: true, email: true, source: true, unsubscribedAt: true, createdAt: true }
        }),
        prisma.user.findMany({
          where: { referrals: { some: {} } },
          select: {
            id: true,
            name: true,
            email: true,
            referralCode: true,
            _count: { select: { referrals: true } }
          },
          take: 25
        }),
        prisma.subscription.count({ where: { status: "ACTIVE", plan: { isFree: true } } }),
        prisma.subscription.count({ where: { status: { in: ["ACTIVE", "TRIALING"] }, plan: { isFree: false } } })
      ]);

    const referralLeaderboard = referrers
      .map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        referralCode: user.referralCode,
        referrals: user._count.referrals
      }))
      .sort((left, right) => right.referrals - left.referrals);

    return {
      newsletter: {
        total: subscriberCount,
        active: activeSubscribers,
        recent: recentSubscribers
      },
      referrals: referralLeaderboard,
      funnel: {
        freeWorkspaces: freeCount,
        paidWorkspaces: paidCount,
        // Share of workspaces that converted from free to paid.
        conversionRate: freeCount + paidCount > 0 ? paidCount / (freeCount + paidCount) : 0
      }
    };
  });
}
