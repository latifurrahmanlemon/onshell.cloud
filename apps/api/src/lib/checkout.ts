import Stripe from "stripe";
import type { PaymentSetting, Plan } from "@prisma/client";
import { PaymentProvider } from "@prisma/client";
import type { RuntimeConfig } from "@onshell/config";
import { decryptSecret } from "./encryption.js";

export interface CheckoutInput {
  plan: Plan;
  billingInterval: "monthly" | "yearly";
  email: string;
  organizationName: string;
}

function decryptPaymentSecret(setting: PaymentSetting, config: RuntimeConfig) {
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
      success_url: `${config.publicBaseUrl}/console?checkout=success`,
      cancel_url: `${config.publicBaseUrl}/?checkout=cancelled`,
      metadata: {
        planCode: input.plan.code,
        billingInterval: input.billingInterval,
        organizationName: input.organizationName
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.plan.currency.toLowerCase(),
            unit_amount: amount,
            product_data: {
              name: `Onshell.cloud ${input.plan.name}`,
              description: input.plan.description
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

