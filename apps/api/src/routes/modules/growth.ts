import type { FastifyInstance } from "fastify";
import type { Plan } from "@prisma/client";
import type { RuntimeConfig } from "@onshell/config";
import { canManageUsers } from "@onshell/shared";
import { z } from "zod";
import { createCheckoutSession } from "../../lib/checkout.js";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { recordAudit } from "../../lib/prisma-mappers.js";
import { generateReferralCode } from "../../lib/provisioning.js";
import { handleRouteError } from "../../lib/reply.js";

/** Fraction of a limit at which the console starts nudging an upgrade. */
const NEAR_LIMIT_RATIO = 0.8;

const checkoutSchema = z.object({
  planCode: z.string().min(2).max(40),
  billingInterval: z.enum(["monthly", "yearly"]).default("monthly")
});

function usageEntry(used: number, limit: number | null) {
  return {
    used,
    limit,
    /** 0-1, or null when the limit is unlimited. */
    ratio: limit === null || limit === 0 ? null : Math.min(used / limit, 1),
    atLimit: limit !== null && used >= limit,
    nearLimit: limit !== null && limit > 0 && used / limit >= NEAR_LIMIT_RATIO
  };
}

/**
 * The plan shape the console renders — limits and marketing copy, but none of
 * the provider bookkeeping columns.
 */
function toConsolePlan(plan: Plan) {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    tagline: plan.tagline,
    badge: plan.badge,
    isFree: plan.isFree,
    isFeatured: plan.isFeatured,
    displayOrder: plan.displayOrder,
    priceMonthlyCents: plan.priceMonthlyCents,
    priceYearlyCents: plan.priceYearlyCents,
    currency: plan.currency,
    maxUsers: plan.maxUsers,
    maxHosts: plan.maxHosts,
    maxConcurrentSessions: plan.maxConcurrentSessions,
    monthlyAiMessages: plan.monthlyAiMessages,
    auditRetentionDays: plan.auditRetentionDays,
    trialDays: plan.trialDays,
    features: Array.isArray(plan.features) ? (plan.features as string[]) : []
  };
}

export async function registerGrowthRoutes(app: FastifyInstance, config: RuntimeConfig) {
  /**
   * Everything the console's plan/usage panel and upgrade nudges need in one
   * request: current plan, live usage against its limits, the next tier up, and
   * the caller's referral link.
   */
  app.get("/me/growth", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const [subscription, memberCount, hostCount, activeSessionCount, plans, referralCount] =
        await Promise.all([
          prisma.subscription.findFirst({
            where: { organizationId: user.organizationId },
            orderBy: { createdAt: "desc" },
            include: { plan: true }
          }),
          prisma.organizationMember.count({ where: { organizationId: user.organizationId } }),
          prisma.host.count({ where: { organizationId: user.organizationId } }),
          prisma.session.count({
            where: { organizationId: user.organizationId, status: { in: ["PENDING", "ACTIVE"] } }
          }),
          prisma.plan.findMany({ where: { isActive: true }, orderBy: { displayOrder: "asc" } }),
          prisma.user.count({ where: { referredById: user.id } })
        ]);

      const plan = subscription?.plan ?? null;

      // AI usage is per-user (the quota is personal), unlike seats/hosts.
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const aiMessagesUsed = await prisma.aiMessage.count({
        where: { role: "USER", createdAt: { gte: monthStart }, thread: { userId: user.id } }
      });

      // The next tier is the cheapest active plan that raises a limit the
      // workspace is actually pressing against.
      const currentOrder = plan?.displayOrder ?? -1;
      const upgradePlan = plans.find((candidate) => candidate.displayOrder > currentOrder && !candidate.isFree) ?? null;

      const usage = {
        members: usageEntry(memberCount, plan?.maxUsers ?? null),
        hosts: usageEntry(hostCount, plan?.maxHosts ?? null),
        concurrentSessions: usageEntry(activeSessionCount, plan?.maxConcurrentSessions ?? null),
        aiMessages: usageEntry(aiMessagesUsed, plan?.monthlyAiMessages ?? null)
      };

      const shouldPromptUpgrade =
        Boolean(upgradePlan) &&
        (plan?.isFree === true ||
          Object.values(usage).some((entry) => entry.nearLimit || entry.atLimit));

      // Backfill a referral code for accounts created before the programme.
      let referralCode = user.referralCode ?? null;
      if (!referralCode) {
        referralCode = await generateReferralCode();
        await prisma.user.update({ where: { id: user.id }, data: { referralCode } });
      }

      return {
        plan: plan ? { id: plan.id, ...toConsolePlan(plan) } : null,
        /** Every plan on sale, so the console can render the upgrade grid without a second request. */
        plans: plans.map(toConsolePlan),
        subscription: subscription
          ? {
              id: subscription.id,
              status: subscription.status,
              billingInterval: subscription.billingInterval,
              currentPeriodEnd: subscription.currentPeriodEnd,
              trialEndsAt: subscription.trialEndsAt,
              cancelAt: subscription.cancelAt
            }
          : null,
        usage,
        upgrade: upgradePlan
          ? { shouldPrompt: shouldPromptUpgrade, plan: toConsolePlan(upgradePlan) }
          : null,
        /** Only owners and admins may start a checkout; the UI hides the buttons for everyone else. */
        canManageBilling: canManageUsers(user.role),
        referral: {
          code: referralCode,
          url: `${config.siteUrl}/signup?ref=${referralCode}`,
          signups: referralCount
        }
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * Starts a plan change for the signed-in workspace.
   *
   * Unlike POST /checkout — which serves anonymous visitors coming off the
   * pricing page and therefore has to collect an email and a workspace name —
   * this route already knows who the customer is, so an owner can upgrade in
   * two clicks from the console.
   *
   * When no payment provider is configured (or the provider is MANUAL) there is
   * no URL to send the browser to, so the request is filed as a sales enquiry
   * instead. That keeps the button honest on deployments that invoice by hand
   * rather than dead-ending the user at a 404.
   */
  app.post(
    "/me/billing/checkout",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const user = await getAuthenticatedUser(request, config);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        if (!canManageUsers(user.role)) {
          return reply.code(403).send({
            error: "billing_forbidden",
            message: "Only workspace owners and admins can change the plan."
          });
        }

        const body = checkoutSchema.parse(request.body);
        const [plan, organization, subscription] = await Promise.all([
          prisma.plan.findFirst({ where: { code: body.planCode, isActive: true } }),
          prisma.organization.findUnique({
            where: { id: user.organizationId },
            select: { name: true }
          }),
          prisma.subscription.findFirst({
            where: { organizationId: user.organizationId },
            orderBy: { createdAt: "desc" },
            select: { planId: true, billingInterval: true }
          })
        ]);

        if (!plan) return reply.code(404).send({ error: "plan_not_found" });
        if (plan.isFree) {
          return reply.code(400).send({
            error: "plan_is_free",
            message: "The free plan cannot be purchased. Contact support to move back down to it."
          });
        }
        if (
          subscription?.planId === plan.id &&
          subscription.billingInterval === (body.billingInterval === "yearly" ? "YEARLY" : "MONTHLY")
        ) {
          return reply.code(409).send({
            error: "already_on_plan",
            message: `This workspace is already on ${plan.name}.`
          });
        }

        const paymentSetting = await prisma.paymentSetting.findFirst({
          where: { enabled: true },
          orderBy: [{ provider: "asc" }, { mode: "asc" }]
        });
        const checkout = await createCheckoutSession(
          {
            plan,
            billingInterval: body.billingInterval,
            email: user.email,
            organizationName: organization?.name ?? "Workspace",
            organizationId: user.organizationId
          },
          paymentSetting,
          config
        );

        // No provider means no hosted page worth opening — the mock URL from
        // createCheckoutSession is a placeholder, not a real checkout.
        const selfServe = checkout.provider !== "manual" && Boolean(checkout.checkoutUrl);

        if (!selfServe) {
          await prisma.contactMessage.create({
            data: {
              name: user.name,
              email: user.email,
              company: organization?.name ?? null,
              topic: "sales",
              message: [
                `Upgrade request from the console.`,
                `Workspace: ${organization?.name ?? "Unknown"}`,
                `Requested plan: ${plan.name} (${plan.code}), billed ${body.billingInterval}.`
              ].join("\n"),
              ipAddress: request.ip,
              userAgent: request.headers["user-agent"] ?? null,
              submittedById: user.id
            }
          });
        }

        await recordAudit({
          organizationId: user.organizationId,
          actorId: user.id,
          action: "billing.checkout.started",
          targetType: "plan",
          targetId: plan.code,
          ipAddress: request.ip,
          metadata: {
            billingInterval: body.billingInterval,
            provider: checkout.provider,
            status: checkout.status,
            selfServe
          }
        });

        return reply.code(201).send({
          status: selfServe ? checkout.status : "sales_followup",
          selfServe,
          provider: checkout.provider,
          checkoutUrl: selfServe ? checkout.checkoutUrl : null,
          plan: toConsolePlan(plan),
          billingInterval: body.billingInterval,
          message: selfServe
            ? undefined
            : `Thanks — we've logged your request to move to ${plan.name}. Our team will email ${user.email} with the invoice shortly.`
        });
      } catch (error) {
        return handleRouteError(reply, error);
      }
    }
  );
}
