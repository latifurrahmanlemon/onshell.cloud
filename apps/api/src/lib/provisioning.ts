import { randomBytes } from "node:crypto";
import { loadConfig } from "@onshell/config";
import { prisma } from "./prisma.js";

const config = loadConfig("api");

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

/**
 * Display name of the built-in host.
 *
 * Deliberately names the server, not "this computer": the earlier wording read as
 * the visitor's own machine, which is the opposite of what this host is.
 */
export const LOCAL_HOST_NAME = "Onshell server (local shell)";

/**
 * Gives an organization a shell on the machine the gateway runs on.
 *
 * NOT the visitor's computer — the gateway's own host. On a shared deployment
 * that is a shell on your server for every account that signs up, so this is
 * gated behind LOCAL_SHELL_ENABLED, which defaults to off and is only sensible
 * for a single-tenant or self-hosted install.
 *
 * The address is recorded as 127.0.0.1 for display only; a local session never
 * opens a socket, it spawns a shell in the gateway process (see the gateway's
 * local transport).
 *
 * Idempotent, so it is safe to call on every signup and as a lazy backfill.
 */
export async function ensureLocalHost(organizationId: string) {
  if (!config.localShellEnabled) return undefined;

  const existing = await prisma.host.findFirst({
    where: { organizationId, isLocal: true },
    select: { id: true }
  });
  if (existing) return existing.id;

  const host = await prisma.host.create({
    data: {
      organizationId,
      name: LOCAL_HOST_NAME,
      type: "SSH",
      address: "127.0.0.1",
      port: 22,
      environment: "DEVELOPMENT",
      isLocal: true,
      health: "online",
      notes:
        "Shell and file browser on the machine Onshell itself runs on — not your own computer. No credential required."
    },
    select: { id: true }
  });

  return host.id;
}
