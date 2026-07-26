import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { generateReferralCode } from "../../lib/provisioning.js";
import { handleRouteError } from "../../lib/reply.js";

/** Fraction of a limit at which the console starts nudging an upgrade. */
const NEAR_LIMIT_RATIO = 0.8;

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
        plan: plan
          ? {
              id: plan.id,
              code: plan.code,
              name: plan.name,
              isFree: plan.isFree,
              tagline: plan.tagline,
              priceMonthlyCents: plan.priceMonthlyCents,
              priceYearlyCents: plan.priceYearlyCents,
              currency: plan.currency,
              auditRetentionDays: plan.auditRetentionDays,
              trialDays: plan.trialDays
            }
          : null,
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
          ? {
              shouldPrompt: shouldPromptUpgrade,
              plan: {
                code: upgradePlan.code,
                name: upgradePlan.name,
                tagline: upgradePlan.tagline,
                priceMonthlyCents: upgradePlan.priceMonthlyCents,
                priceYearlyCents: upgradePlan.priceYearlyCents,
                currency: upgradePlan.currency,
                maxUsers: upgradePlan.maxUsers,
                maxHosts: upgradePlan.maxHosts,
                trialDays: upgradePlan.trialDays,
                features: Array.isArray(upgradePlan.features) ? upgradePlan.features : []
              }
            }
          : null,
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
}
