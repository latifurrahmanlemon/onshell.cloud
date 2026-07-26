import { randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";

/**
 * Referral codes are shown in URLs, so they avoid look-alike characters and are
 * uppercase for legibility when someone reads one out loud.
 */
const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERRAL_LENGTH = 8;

function randomReferralCode() {
  const bytes = randomBytes(REFERRAL_LENGTH);
  let code = "";
  for (let index = 0; index < REFERRAL_LENGTH; index += 1) {
    code += REFERRAL_ALPHABET[bytes[index] % REFERRAL_ALPHABET.length];
  }
  return code;
}

/** Generates a referral code that is not already taken. */
export async function generateReferralCode() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = randomReferralCode();
    const existing = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
    if (!existing) return code;
  }
  // Astronomically unlikely; fall back to a longer code rather than looping.
  return `${randomReferralCode()}${randomReferralCode()}`.slice(0, 12);
}

/** Resolves a referral code from a signup form to the referring user's id. */
export async function resolveReferrer(code: string | undefined | null) {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase();
  if (normalized.length < 6 || normalized.length > 12) return undefined;

  const referrer = await prisma.user.findUnique({
    where: { referralCode: normalized },
    select: { id: true }
  });
  return referrer?.id;
}

/**
 * Puts a brand-new organization on the Free plan so the freemium funnel starts
 * immediately: the console can read limits, show usage, and nudge upgrades
 * without waiting for a payment.
 *
 * A no-op when the organization already has a subscription, or when no plan is
 * flagged `isFree` (a deployment that only sells paid tiers).
 */
export async function ensureFreeSubscription(organizationId: string) {
  const existing = await prisma.subscription.findFirst({
    where: { organizationId },
    select: { id: true }
  });
  if (existing) return existing.id;

  const freePlan = await prisma.plan.findFirst({
    where: { isFree: true, isActive: true },
    orderBy: { displayOrder: "asc" }
  });
  if (!freePlan) return undefined;

  const currentPeriodStart = new Date();
  const currentPeriodEnd = new Date(currentPeriodStart);
  currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);

  const subscription = await prisma.subscription.create({
    data: {
      organizationId,
      planId: freePlan.id,
      // The free tier is not a trial — it never lapses into PAST_DUE.
      status: "ACTIVE",
      billingInterval: "MONTHLY",
      currentPeriodStart,
      currentPeriodEnd
    },
    select: { id: true }
  });

  return subscription.id;
}
