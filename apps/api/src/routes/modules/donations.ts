import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import prismaPkg from "@prisma/client";
import Stripe from "stripe";
import { z } from "zod";
import { decryptPaymentSecret } from "../../lib/checkout.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";
import {
  readTurnstileToken,
  turnstileFailureResponse,
  verifyTurnstile,
} from "../../lib/turnstile.js";

const { DonationStatus, PaymentProvider } = prismaPkg;

export const donationSchema = z.object({
  // Stripe accepts at most eight digits for ordinary currencies. Keeping the
  // full range here means this is $1 to the provider's practical USD ceiling.
  amountCents: z.number().int().min(100).max(99_999_999),
  donorName: z.string().trim().max(100).optional(),
  donorEmail: z.string().trim().email().max(254).optional(),
  message: z.string().trim().max(500).optional(),
  source: z.enum(["website", "download", "desktop"]).default("website"),
  turnstileToken: z.string().optional(),
});

async function activeStripeSetting() {
  return prisma.paymentSetting.findFirst({
    where: { provider: PaymentProvider.STRIPE, enabled: true },
    // Prefer live when an old test row is still present beside it.
    orderBy: { mode: "asc" },
  });
}

export async function registerDonationRoutes(
  app: FastifyInstance,
  config: RuntimeConfig,
) {
  app.post(
    "/donations/checkout",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let donationId: string | undefined;
      try {
        const body = donationSchema.parse(request.body);
        const verification = await verifyTurnstile({
          form: "checkout",
          token: readTurnstileToken(request.body),
          remoteIp: request.ip,
          masterEncryptionKey: config.masterEncryptionKey,
          logger: request.log,
        });
        if (!verification.ok) {
          const failure = turnstileFailureResponse(verification);
          return reply.code(failure.status).send(failure.body);
        }

        const setting = await activeStripeSetting();
        const secretKey = setting && decryptPaymentSecret(setting, config);
        if (!setting || !secretKey) {
          return reply.code(503).send({
            error: "donations_unavailable",
            message:
              "Donations are temporarily unavailable. Please try again later.",
          });
        }

        const donation = await prisma.donation.create({
          data: {
            amountCents: body.amountCents,
            currency: "USD",
            donorName: body.donorName || null,
            donorEmail: body.donorEmail?.toLowerCase() || null,
            message: body.message || null,
            source: body.source,
          },
        });
        donationId = donation.id;

        const stripe = new Stripe(secretKey);
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          success_url: `${config.siteUrl}/donate?status=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${config.siteUrl}/donate?status=cancelled`,
          customer_email: body.donorEmail || undefined,
          name_collection: { individual: { enabled: true, optional: true } },
          metadata: {
            kind: "donation",
            donationId: donation.id,
            source: body.source,
          },
          payment_intent_data: {
            metadata: { kind: "donation", donationId: donation.id },
          },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: body.amountCents,
                product_data: {
                  name: "Support Onshell.cloud",
                  description:
                    "A one-time contribution to Onshell development, received by Holy LLC, operator of Onshell.cloud.",
                },
              },
            },
          ],
        });

        if (!session.url)
          throw new Error("Stripe did not return a checkout URL.");
        await prisma.donation.update({
          where: { id: donation.id },
          data: { providerSessionId: session.id },
        });
        return reply.code(201).send({ checkoutUrl: session.url });
      } catch (error) {
        if (donationId) {
          await prisma.donation.updateMany({
            where: { id: donationId, status: DonationStatus.PENDING },
            data: {
              status: DonationStatus.FAILED,
              failureReason: "Checkout could not be started.",
            },
          });
        }
        return handleRouteError(reply, error);
      }
    },
  );
}
