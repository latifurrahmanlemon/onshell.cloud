import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { z } from "zod";
import { createCheckoutSession } from "../../lib/checkout.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";

const checkoutSchema = z.object({
  planCode: z.string().min(2),
  billingInterval: z.enum(["monthly", "yearly"]).default("monthly"),
  email: z.string().email(),
  organizationName: z.string().min(2)
});

function toPublicPlan(plan: Awaited<ReturnType<typeof prisma.plan.findFirstOrThrow>>) {
  return {
    ...plan,
    features: Array.isArray(plan.features) ? plan.features : []
  };
}

export async function registerBillingRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/plans", async () => {
    const plans = await prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: "asc" }
    });

    return plans.map(toPublicPlan);
  });

  app.post("/checkout", async (request, reply) => {
    try {
      const body = checkoutSchema.parse(request.body);
      const plan = await prisma.plan.findFirst({
        where: {
          code: body.planCode,
          isActive: true
        }
      });
      if (!plan) return reply.code(404).send({ error: "plan_not_found" });
      const paymentSetting = await prisma.paymentSetting.findFirst({
        where: { enabled: true },
        orderBy: [{ provider: "asc" }, { mode: "asc" }]
      });
      const checkout = await createCheckoutSession(
        {
          plan,
          billingInterval: body.billingInterval,
          email: body.email,
          organizationName: body.organizationName
        },
        paymentSetting,
        config
      );

      return reply.code(201).send({
        status: checkout.status,
        plan: toPublicPlan(plan),
        billingInterval: body.billingInterval,
        customer: {
          email: body.email,
          organizationName: body.organizationName
        },
        checkoutUrl: checkout.checkoutUrl,
        provider: checkout.provider
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
