import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const transaction = {
    subscription: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    invoice: { upsert: vi.fn() },
  };
  return {
    transaction,
    prisma: {
      donation: { updateMany: vi.fn() },
      organization: { findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
      plan: { findUnique: vi.fn() },
      invoice: { findUnique: vi.fn(), update: vi.fn() },
      subscription: { update: vi.fn() },
      $transaction: vi.fn(async (operation: unknown) =>
        typeof operation === "function"
          ? (operation as (client: typeof transaction) => unknown)(transaction)
          : Promise.all(operation as Promise<unknown>[]),
      ),
    },
  };
});

vi.mock("../../lib/prisma.js", () => ({ prisma: database.prisma }));

import { handleStripeEvent } from "./stripe-webhooks.js";

function checkoutEvent(session: Partial<Stripe.Checkout.Session>) {
  return {
    id: "evt_test",
    type: "checkout.session.completed",
    data: { object: session },
  } as unknown as Stripe.Event;
}

describe("common Stripe webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes donation checkouts to donation history", async () => {
    await handleStripeEvent(
      checkoutEvent({
        metadata: { kind: "donation", donationId: "donation_1" },
        payment_status: "paid",
        amount_total: 500,
        payment_intent: "pi_donation",
        customer_details: {
          email: "donor@example.com",
          name: "Donor",
        } as Stripe.Checkout.Session.CustomerDetails,
      }),
    );

    expect(database.prisma.donation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "donation_1" },
        data: expect.objectContaining({
          status: "PAID",
          providerPaymentId: "pi_donation",
        }),
      }),
    );
    expect(database.prisma.plan.findUnique).not.toHaveBeenCalled();
  });

  it("activates a package and upserts its invoice idempotently", async () => {
    database.prisma.organization.findUnique.mockResolvedValue({ id: "org_1" });
    database.prisma.plan.findUnique.mockResolvedValue({ id: "plan_pro" });
    database.transaction.subscription.findFirst.mockResolvedValue({
      id: "sub_1",
      currentPeriodStart: new Date(1_600_000_000 * 1000),
    });
    database.transaction.subscription.update.mockResolvedValue({ id: "sub_1" });
    database.transaction.invoice.upsert.mockResolvedValue({ id: "invoice_1" });

    await handleStripeEvent(
      checkoutEvent({
        id: "cs_package",
        created: 1_700_000_000,
        metadata: {
          kind: "package",
          planCode: "pro",
          billingInterval: "yearly",
          organizationId: "org_1",
        },
        payment_status: "paid",
        amount_total: 12_000,
        currency: "usd",
        payment_intent: "pi_package",
        customer: "cus_package",
      }),
    );

    expect(database.transaction.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub_1" },
        data: expect.objectContaining({
          planId: "plan_pro",
          status: "ACTIVE",
          billingInterval: "YEARLY",
          providerSubscriptionId: "payment:pi_package",
        }),
      }),
    );
    expect(database.transaction.invoice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerInvoiceId: "pi_package" },
        create: expect.objectContaining({
          subscriptionId: "sub_1",
          amountCents: 12_000,
          status: "paid",
        }),
      }),
    );
  });
});
