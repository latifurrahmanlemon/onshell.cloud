import { randomBytes, createCipheriv, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const isProduction = process.env.NODE_ENV === "production";
const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@onshell.cloud").trim().toLowerCase();

/**
 * Never ship a known admin password. In production the operator must supply one;
 * elsewhere we mint a random one and print it exactly once so local development
 * still works without a checked-in credential.
 */
function resolveAdminPassword() {
  const supplied = process.env.ADMIN_PASSWORD?.trim();
  if (supplied) return { password: supplied, generated: false };

  if (isProduction) {
    throw new Error(
      "ADMIN_PASSWORD is required when seeding with NODE_ENV=production. " +
        "Set it to a strong value (e.g. `openssl rand -base64 24`) and re-run the seed."
    );
  }

  // Satisfies the password policy: length, upper, lower, digit, symbol.
  return { password: `Dev-${randomBytes(12).toString("base64url")}!7`, generated: true };
}

const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function referralCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (let index = 0; index < 8; index += 1) code += REFERRAL_ALPHABET[bytes[index] % REFERRAL_ALPHABET.length];
  return code;
}

/** Mirrors apps/api/src/lib/encryption.ts so bootstrapped secrets are readable by the API. */
function encryptSecret(plainText: string, masterKey: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(masterKey).digest(), nonce);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return {
    encryptedPayload: encrypted.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

const AI_SYSTEM_PROMPT = [
  "You are Onshell Assistant, the in-product AI helper for Onshell.cloud — a browser-based SSH, SFTP, and RDP workspace for teams.",
  "",
  "Help users with:",
  "- Onshell.cloud itself: registering hosts, the credential vault, opening SSH/SFTP/RDP sessions, snippets, roles and permissions, audit logs, plans and billing.",
  "- Practical Linux, shell, and SSH work: commands, config files, key management, permissions, systemd, networking, Docker, and troubleshooting.",
  "",
  "Rules:",
  "- Be concise and practical. Lead with the command or the answer, then explain briefly.",
  "- Use fenced code blocks for commands and config, and say which file a snippet belongs in.",
  "- Never ask for, repeat, or store passwords, private keys, or other secrets. If a user pastes one, tell them to rotate it and do not echo it back.",
  "- Flag destructive commands (rm -rf, dd, mkfs, iptables -F, DROP TABLE) before giving them, and suggest the safe/dry-run form first.",
  "- If something depends on the user's plan or permissions, say so and point to the relevant part of the console.",
  "- If you do not know, say so instead of guessing at Onshell.cloud behaviour."
].join("\n");

/**
 * Freemium ladder: one genuinely useful free tier for a solo operator, then two
 * paid tiers — Team for small squads and Business for growing DevOps orgs.
 * Enterprise is handled as a sales conversation via /contact, not a self-serve
 * plan, so it deliberately has no row here.
 */
const plans = [
  {
    code: "free",
    name: "Free",
    description:
      "For one person. Everything you need to replace a desktop SSH client: browser terminals, SFTP, and an encrypted vault for a handful of servers.",
    tagline: "Free forever for solo operators",
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    maxUsers: 1,
    maxHosts: 3,
    maxConcurrentSessions: 1,
    auditRetentionDays: 7,
    monthlyAiMessages: 25,
    isFree: true,
    isFeatured: false,
    badge: "Free forever",
    trialDays: 0,
    displayOrder: 1,
    features: [
      "1 user",
      "Up to 3 hosts",
      "Browser SSH terminal",
      "SFTP file manager",
      "Encrypted credential vault",
      "25 AI assistant messages / month",
      "7-day audit history"
    ]
  },
  {
    code: "team",
    name: "Team",
    description:
      "For small teams that share servers. Adds RDP, shared snippets, role-based access, and a real audit trail — billed per workspace, not per seat.",
    tagline: "Most teams start here",
    priceMonthlyCents: 1900,
    priceYearlyCents: 19000,
    maxUsers: 10,
    maxHosts: 50,
    maxConcurrentSessions: 10,
    auditRetentionDays: 90,
    monthlyAiMessages: 500,
    isFree: false,
    isFeatured: true,
    badge: "Most popular",
    trialDays: 14,
    displayOrder: 2,
    features: [
      "Up to 10 users",
      "Up to 50 hosts",
      "Everything in Free",
      "Browser RDP sessions",
      "Shared team snippets",
      "Role-based host permissions",
      "500 AI assistant messages / month",
      "90-day audit retention",
      "14-day free trial"
    ]
  },
  {
    code: "business",
    name: "Business",
    description:
      "For growing DevOps organisations that need governance: longer retention, higher concurrency, SSO readiness, and priority support.",
    tagline: "Governance and scale",
    priceMonthlyCents: 4900,
    priceYearlyCents: 49000,
    maxUsers: 50,
    maxHosts: 300,
    maxConcurrentSessions: 50,
    auditRetentionDays: 365,
    monthlyAiMessages: null,
    isFree: false,
    isFeatured: false,
    badge: null,
    trialDays: 14,
    displayOrder: 3,
    features: [
      "Up to 50 users",
      "Up to 300 hosts",
      "Everything in Team",
      "Unlimited AI assistant messages",
      "365-day audit retention",
      "SAML / OIDC ready",
      "Session recording exports",
      "Priority support",
      "14-day free trial"
    ]
  }
];

async function seedAdmin() {
  const { password, generated } = resolveAdminPassword();
  const passwordHash = await bcrypt.hash(password, 12);

  const organization = await prisma.organization.upsert({
    where: { slug: "onshell-cloud" },
    update: { name: "Onshell.cloud" },
    create: {
      name: "Onshell.cloud",
      slug: "onshell-cloud"
    }
  });

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      isPlatformAdmin: true,
      // Only reset the password when one was explicitly supplied, so re-running
      // the seed does not silently rotate a live admin credential.
      ...(process.env.ADMIN_PASSWORD?.trim() ? { passwordHash } : {}),
      referralCode: existing?.referralCode ?? referralCode()
    },
    create: {
      email: adminEmail,
      name: "Platform Admin",
      passwordHash,
      isPlatformAdmin: true,
      twoFactorEnabled: false,
      referralCode: referralCode()
    }
  });

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: admin.id
      }
    },
    update: { role: "OWNER" },
    create: {
      organizationId: organization.id,
      userId: admin.id,
      role: "OWNER"
    }
  });

  if (generated && !existing) {
    console.log("");
    console.log("  ┌─────────────────────────────────────────────────────────────┐");
    console.log("  │  Generated a development admin password (shown once):       │");
    console.log(`  │  ${adminEmail.padEnd(58)}│`);
    console.log(`  │  ${password.padEnd(58)}│`);
    console.log("  └─────────────────────────────────────────────────────────────┘");
    console.log("");
  }

  return { organization, admin };
}

async function seedPlans() {
  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan
    });
  }

  // Retire tiers from earlier revisions rather than deleting them, so existing
  // subscriptions keep resolving while the plan disappears from public pricing.
  await prisma.plan.updateMany({
    where: { code: { in: ["starter", "enterprise"] } },
    data: { isActive: false, isFeatured: false, displayOrder: 90 }
  });
}

async function seedSettings(adminId: string) {
  const masterKey = process.env.MASTER_ENCRYPTION_KEY ?? "development-only-change-me";

  await prisma.smtpSetting.upsert({
    where: { id: "global" },
    update: {
      fromEmail: process.env.SMTP_FROM_EMAIL ?? "noreply@onshell.cloud",
      fromName: process.env.SMTP_FROM_NAME ?? "Onshell.cloud",
      updatedById: adminId
    },
    create: {
      id: "global",
      host: process.env.SMTP_HOST ?? "smtp.example.com",
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: (process.env.SMTP_SECURE ?? "true") !== "false",
      username: process.env.SMTP_USER || undefined,
      fromEmail: process.env.SMTP_FROM_EMAIL ?? "noreply@onshell.cloud",
      fromName: process.env.SMTP_FROM_NAME ?? "Onshell.cloud",
      enabled: false,
      updatedById: adminId
    }
  });

  await prisma.appSetting.upsert({
    where: { key: "platform.brand" },
    update: {
      value: {
        name: "Onshell.cloud",
        domain: "onshell.cloud",
        supportEmail: "support@onshell.cloud",
        salesEmail: "sales@onshell.cloud"
      },
      updatedById: adminId
    },
    create: {
      key: "platform.brand",
      category: "platform",
      value: {
        name: "Onshell.cloud",
        domain: "onshell.cloud",
        supportEmail: "support@onshell.cloud",
        salesEmail: "sales@onshell.cloud"
      },
      updatedById: adminId
    }
  });

  await prisma.paymentSetting.upsert({
    where: { provider_mode: { provider: "STRIPE", mode: "test" } },
    update: {},
    create: { provider: "STRIPE", mode: "test", enabled: false }
  });

  // Turnstile: bootstrap from env on first run only. After that the admin panel
  // owns these values, so a re-seed must not clobber a rotated key.
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY?.trim();
  const encryptedTurnstile = turnstileSecret ? encryptSecret(turnstileSecret, masterKey) : undefined;

  await prisma.turnstileSetting.upsert({
    where: { id: "global" },
    update: {},
    create: {
      id: "global",
      siteKey: process.env.TURNSTILE_SITE_KEY?.trim() || null,
      encryptedSecretKey: encryptedTurnstile?.encryptedPayload,
      secretKeyNonce: encryptedTurnstile?.nonce,
      secretKeyAuthTag: encryptedTurnstile?.authTag,
      enabled: process.env.TURNSTILE_ENABLED === "true" && Boolean(turnstileSecret),
      updatedById: adminId
    }
  });

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const encryptedOpenAi = openAiKey ? encryptSecret(openAiKey, masterKey) : undefined;

  await prisma.aiSetting.upsert({
    where: { id: "global" },
    update: {},
    create: {
      id: "global",
      provider: "openai",
      model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
      baseUrl: process.env.OPENAI_BASE_URL?.trim() || null,
      encryptedApiKey: encryptedOpenAi?.encryptedPayload,
      apiKeyNonce: encryptedOpenAi?.nonce,
      apiKeyAuthTag: encryptedOpenAi?.authTag,
      systemPrompt: AI_SYSTEM_PROMPT,
      enabled: process.env.AI_ASSISTANT_ENABLED === "true" && Boolean(openAiKey),
      updatedById: adminId
    }
  });
}

async function main() {
  const { organization, admin } = await seedAdmin();
  await seedPlans();
  await seedSettings(admin.id);

  // Put the platform's own workspace on the top self-serve tier so the admin
  // account is not limited by the Free plan while operating the platform.
  const businessPlan = await prisma.plan.findUniqueOrThrow({ where: { code: "business" } });
  const currentPeriodStart = new Date();
  const currentPeriodEnd = new Date(currentPeriodStart);
  currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);

  await prisma.subscription.upsert({
    where: { id: "seed_onshell_platform_subscription" },
    update: {
      planId: businessPlan.id,
      status: "ACTIVE",
      billingInterval: "YEARLY",
      currentPeriodStart,
      currentPeriodEnd
    },
    create: {
      id: "seed_onshell_platform_subscription",
      organizationId: organization.id,
      planId: businessPlan.id,
      status: "ACTIVE",
      billingInterval: "YEARLY",
      currentPeriodStart,
      currentPeriodEnd
    }
  });

  console.log(`Seeded Onshell.cloud: admin ${adminEmail}, plans ${plans.map((plan) => plan.code).join(", ")}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
