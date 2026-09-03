import Stripe from "stripe";
import prismaPkg, { type PaymentSetting, type Plan } from "@prisma/client";
const { PaymentProvider } = prismaPkg;
import type { RuntimeConfig } from "@onshell/config";
import { decryptSecret } from "./encryption.js";

export interface CheckoutInput {
  plan: Plan;
  billingInterval: "monthly" | "yearly";
  email: string;
  organizationName: string;
  organizationId?: string;
}

export function decryptPaymentSecret(setting: PaymentSetting, config: RuntimeConfig) {
  if (!setting.encryptedSecretKey || !setting.secretKeyNonce || !setting.secretKeyAuthTag) return undefined;

  return decryptSecret(
    {
      encryptedPayload: setting.encryptedSecretKey,
      nonce: setting.secretKeyNonce,
      authTag: setting.secretKeyAuthTag
    },
    config.masterEncryptionKey
  );
}

export function decryptWebhookSecret(setting: PaymentSetting, config: RuntimeConfig) {
  if (!setting.encryptedWebhookSecret || !setting.webhookSecretNonce || !setting.webhookSecretAuthTag) return undefined;

  return decryptSecret(
    {
      encryptedPayload: setting.encryptedWebhookSecret,
      nonce: setting.webhookSecretNonce,
      authTag: setting.webhookSecretAuthTag
    },
    config.masterEncryptionKey
  );
}

export async function createCheckoutSession(input: CheckoutInput, setting: PaymentSetting | null, config: RuntimeConfig) {
  if (!setting || !setting.enabled) {
    return {
      status: "payment_provider_not_configured",
      checkoutUrl: `${config.publicBaseUrl}/checkout/mock?plan=${input.plan.code}&interval=${input.billingInterval}`,
      provider: "manual"
    };
  }

  if (setting.provider === PaymentProvider.MANUAL) {
    return {
      status: "manual_invoice_ready",
      checkoutUrl: `${config.publicBaseUrl}/checkout/manual?plan=${input.plan.code}&interval=${input.billingInterval}`,
      provider: "manual"
    };
  }

  if (setting.provider === PaymentProvider.STRIPE) {
    const secretKey = decryptPaymentSecret(setting, config);
    if (!secretKey) {
      return {
        status: "stripe_secret_missing",
        checkoutUrl: null,
        provider: "stripe"
      };
    }

    const stripe = new Stripe(secretKey);
    const amount =
      input.billingInterval === "monthly" ? input.plan.priceMonthlyCents : input.plan.priceYearlyCents;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: input.email,
      success_url: `${config.publicBaseUrl}/console?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicBaseUrl}/?checkout=cancelled`,
      metadata: {
        kind: "package",
        planCode: input.plan.code,
        billingInterval: input.billingInterval,
        organizationName: input.organizationName,
        customerEmail: input.email,
        ...(input.organizationId ? { organizationId: input.organizationId } : {})
      },
      payment_intent_data: {
        metadata: {
          kind: "package",
          planCode: input.plan.code,
          billingInterval: input.billingInterval,
          ...(input.organizationId ? { organizationId: input.organizationId } : {})
        }
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.plan.currency.toLowerCase(),
            unit_amount: amount,
            product_data: {
              name: `Onshell.cloud ${input.plan.name}`,
              description: `${input.plan.description} Onshell.cloud is operated by Holy LLC.`
            }
          }
        }
      ]
    });

    return {
      status: "checkout_ready",
      checkoutUrl: session.url,
      provider: "stripe",
      providerSessionId: session.id
    };
  }

  return {
    status: "provider_not_implemented",
    checkoutUrl: null,
    provider: setting.provider.toLowerCase()
  };
}
