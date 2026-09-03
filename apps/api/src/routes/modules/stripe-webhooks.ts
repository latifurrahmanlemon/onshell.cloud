import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import prismaPkg from "@prisma/client";
import Stripe from "stripe";
import { z } from "zod";
import { decryptPaymentSecret, decryptWebhookSecret } from "../../lib/checkout.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";

const {
  BillingInterval,
  DonationStatus,
  PaymentProvider,
  SubscriptionStatus,
} = prismaPkg;

function stripeId(value: string | { id: string } | null) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

async function activeStripeSetting() {
  return prisma.paymentSetting.findFirst({
    where: { provider: PaymentProvider.STRIPE, enabled: true },
    // "live" sorts before "test", preventing a stale test row from taking
    // production traffic when both records exist.
    orderBy: { mode: "asc" },
  });
}

async function configuredStripeClients(config: RuntimeConfig) {
  const settings = await prisma.paymentSetting.findMany({
    where: { provider: PaymentProvider.STRIPE, enabled: true },
    orderBy: { mode: "asc" },
  });
  return settings.flatMap((setting) => {
    const secretKey = decryptPaymentSecret(setting, config);
    const webhookSecret = decryptWebhookSecret(setting, config);
    return secretKey
      ? [{ stripe: new Stripe(secretKey), webhookSecret }]
      : [];
  });
}

const confirmationSchema = z.object({
  sessionId: z.string().trim().regex(/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/).max(255),
});

async function applyDonationCheckout(
  session: Stripe.Checkout.Session,
  outcome: "paid" | "failed",
) {
  const donationId = session.metadata?.donationId;
  if (session.metadata?.kind !== "donation" || !donationId) return;

  const paid = outcome === "paid" && session.payment_status === "paid";
  await prisma.donation.updateMany({
    where: { id: donationId },
    data: {
      status: paid ? DonationStatus.PAID : DonationStatus.FAILED,
      amountCents: session.amount_total ?? undefined,
      donorEmail:
        session.customer_details?.email ?? session.customer_email ?? undefined,
      donorName: session.customer_details?.name ?? undefined,
      providerPaymentId: stripeId(session.payment_intent) ?? undefined,
      paidAt: paid ? new Date() : undefined,
      failureReason: paid ? null : "Payment was not completed.",
    },
  });
}

function packagePeriod(start: Date, interval: string | undefined) {
  const end = new Date(start);
  if (interval === "yearly") end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return end;
}

async function resolvePackageOrganization(session: Stripe.Checkout.Session) {
  if (session.metadata?.organizationId) {
    const organization = await prisma.organization.findUnique({
      where: { id: session.metadata.organizationId },
      select: { id: true },
    });
    if (organization) return organization.id;
  }

  const email = (
    session.customer_details?.email ??
    session.customer_email ??
    session.metadata?.customerEmail
  )?.toLowerCase();
  if (!email) return null;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      memberships: {
        orderBy: { createdAt: "asc" },
        select: { organizationId: true, organization: { select: { name: true } } },
      },
    },
  });
  const named = user?.memberships.find(
    (membership) =>
      membership.organization.name.toLowerCase() ===
      session.metadata?.organizationName?.toLowerCase(),
  );
  return named?.organizationId ?? user?.memberships[0]?.organizationId ?? null;
}

async function applyPackageCheckout(session: Stripe.Checkout.Session) {
  if (session.metadata?.kind !== "package" || session.payment_status !== "paid")
    return;

  const planCode = session.metadata.planCode;
  if (!planCode) throw new Error("Paid package checkout is missing planCode metadata.");

  const [plan, organizationId] = await Promise.all([
    prisma.plan.findUnique({ where: { code: planCode }, select: { id: true } }),
    resolvePackageOrganization(session),
  ]);
  if (!plan) throw new Error(`Paid package checkout references unknown plan ${planCode}.`);
  if (!organizationId) {
    // Returning a failure asks Stripe to retry. This also lets a public-site
    // buyer create their account shortly after payment and be linked on retry.
    throw new Error("Paid package checkout could not be linked to a workspace.");
  }

  const currentPeriodStart = new Date(session.created * 1000);
  const currentPeriodEnd = packagePeriod(
    currentPeriodStart,
    session.metadata.billingInterval,
  );
  const billingInterval =
    session.metadata.billingInterval === "yearly"
      ? BillingInterval.YEARLY
      : BillingInterval.MONTHLY;
  const providerPaymentId = stripeId(session.payment_intent);
  const providerCustomerId = stripeId(session.customer);

  await prisma.$transaction(async (transaction) => {
    const existing = await transaction.subscription.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      select: { id: true, currentPeriodStart: true },
    });
    const providerPurchaseId = `payment:${providerPaymentId ?? session.id}`;
    const subscription = existing?.currentPeriodStart && existing.currentPeriodStart > currentPeriodStart
      ? existing
      : existing
      ? await transaction.subscription.update({
          where: { id: existing.id },
          data: {
            planId: plan.id,
            status: SubscriptionStatus.ACTIVE,
            billingInterval,
            currentPeriodStart,
            currentPeriodEnd,
            cancelAt: null,
            providerCustomerId,
            providerSubscriptionId: providerPurchaseId,
          },
          select: { id: true },
        })
      : await transaction.subscription.create({
          data: {
            organizationId,
            planId: plan.id,
            status: SubscriptionStatus.ACTIVE,
            billingInterval,
            currentPeriodStart,
            currentPeriodEnd,
            providerCustomerId,
            providerSubscriptionId: providerPurchaseId,
          },
          select: { id: true },
        });

    await transaction.invoice.upsert({
      where: { providerInvoiceId: providerPaymentId ?? `checkout:${session.id}` },
      create: {
        subscriptionId: subscription.id,
        amountCents: session.amount_total ?? 0,
        currency: session.currency?.toUpperCase() ?? "USD",
        status: "paid",
        providerInvoiceId: providerPaymentId ?? `checkout:${session.id}`,
        paidAt: new Date(),
      },
      update: {
        subscriptionId: subscription.id,
        amountCents: session.amount_total ?? 0,
        currency: session.currency?.toUpperCase() ?? "USD",
        status: "paid",
        paidAt: new Date(),
      },
    });
  });
}

export async function handleStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      if (session.metadata?.kind === "package") await applyPackageCheckout(session);
      else await applyDonationCheckout(session, "paid");
      break;
    }
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      await applyDonationCheckout(event.data.object, "failed");
      break;
    case "charge.refunded": {
      const charge = event.data.object;
      const intentId = stripeId(charge.payment_intent);
      if (!intentId || !charge.refunded) break;

      await prisma.donation.updateMany({
        where: { providerPaymentId: intentId },
        data: { status: DonationStatus.REFUNDED },
      });
      const invoice = await prisma.invoice.findUnique({
        where: { providerInvoiceId: intentId },
        select: {
          subscriptionId: true,
          subscription: { select: { providerSubscriptionId: true } },
        },
      });
      if (invoice) {
        if (invoice.subscription.providerSubscriptionId === `payment:${intentId}`) {
          await prisma.$transaction([
            prisma.invoice.update({
              where: { providerInvoiceId: intentId },
              data: { status: "refunded" },
            }),
            prisma.subscription.update({
              where: { id: invoice.subscriptionId },
              data: { status: SubscriptionStatus.CANCELED, cancelAt: new Date() },
            }),
          ]);
        } else {
          await prisma.invoice.update({
            where: { providerInvoiceId: intentId },
            data: { status: "refunded" },
          });
        }
      }
      break;
    }
  }
}

async function confirmCheckoutSession(session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid") return false;
  if (session.metadata?.kind === "package") await applyPackageCheckout(session);
  else if (session.metadata?.kind === "donation") await applyDonationCheckout(session, "paid");
  else throw new Error("Stripe checkout has no supported payment kind.");
  return true;
}

export async function registerStripeWebhookRoutes(
  app: FastifyInstance,
  config: RuntimeConfig,
) {
  // The browser calls this after Stripe redirects back. It verifies the session
  // directly with Stripe, so checkout remains functional when no webhook is
  // configured. Webhooks are still recommended for abandoned browser returns.
  app.post(
    "/payments/stripe/confirm",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const { sessionId } = confirmationSchema.parse(request.body);
        const clients = await configuredStripeClients(config);
        if (clients.length === 0) {
          return reply.code(503).send({ error: "stripe_not_configured" });
        }

        let session: Stripe.Checkout.Session | undefined;
        for (const client of clients) {
          try {
            session = await client.stripe.checkout.sessions.retrieve(sessionId);
            break;
          } catch {
            // A test session cannot be retrieved with the live key (or vice
            // versa), so try each enabled Stripe mode.
          }
        }
        if (!session) return reply.code(404).send({ error: "checkout_not_found" });

        const confirmed = await confirmCheckoutSession(session);
        if (!confirmed) {
          return reply.code(409).send({
            error: "payment_not_complete",
            status: session.payment_status,
          });
        }
        return { confirmed: true, kind: session.metadata?.kind };
      } catch (error) {
        return handleRouteError(reply, error);
      }
    },
  );

  // Stripe signs the exact request bytes. Keep the raw parser scoped to these
  // endpoints so ordinary application/json routes still receive parsed JSON.
  await app.register(async (webhookApp) => {
    webhookApp.removeContentTypeParser("application/json");
    webhookApp.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    const webhookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: "invalid_webhook" });
      }

      const clients = (await configuredStripeClients(config)).filter(
        (client) => Boolean(client.webhookSecret),
      );
      if (clients.length === 0) {
        request.log.error("Stripe webhook is not configured");
        return reply.code(503).send({ error: "webhook_not_configured" });
      }

      let event: Stripe.Event | undefined;
      for (const client of clients) {
        try {
          event = client.stripe.webhooks.constructEvent(
            request.body,
            signature,
            client.webhookSecret!,
          );
          break;
        } catch {
          // Test and live Stripe endpoints have different signing secrets. Try
          // every enabled mode before rejecting the delivery.
        }
      }
      if (!event) {
        request.log.warn("Rejected Stripe webhook signature");
        return reply.code(400).send({ error: "invalid_webhook" });
      }

      try {
        await handleStripeEvent(event);
        return { received: true };
      } catch (error) {
        request.log.error({ err: error, eventId: event.id }, "Stripe webhook processing failed");
        return reply.code(500).send({ error: "webhook_processing_failed" });
      }
    };

    webhookApp.post("/webhooks/stripe", { config: { rateLimit: false } }, webhookHandler);
    // Compatibility alias: existing Stripe dashboard configuration keeps
    // working while production is switched to the common endpoint.
    webhookApp.post(
      "/donations/webhook/stripe",
      { config: { rateLimit: false } },
      webhookHandler,
    );
  });
}
