import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const adminEmail = process.env.ADMIN_EMAIL ?? "latifur.tech@gmial.com";
const adminPassword = process.env.ADMIN_PASSWORD ?? "Lemon553&";

const plans = [
  {
    code: "starter",
    name: "Starter",
    description: "For small teams that need secure browser SSH and SFTP.",
    priceMonthlyCents: 1900,
    priceYearlyCents: 19000,
    maxUsers: 5,
    maxHosts: 20,
    maxConcurrentSessions: 5,
    auditRetentionDays: 30,
    displayOrder: 1,
    features: ["SSH terminal", "SFTP file manager", "Credential vault", "30-day audit logs"]
  },
  {
    code: "business",
    name: "Business",
    description: "For growing DevOps teams with RDP, snippets, and approval workflows.",
    priceMonthlyCents: 4900,
    priceYearlyCents: 49000,
    maxUsers: 25,
    maxHosts: 150,
    maxConcurrentSessions: 25,
    auditRetentionDays: 180,
    displayOrder: 2,
    features: ["Everything in Starter", "Browser RDP", "Team snippets", "180-day audit logs", "Priority support"]
  },
  {
    code: "enterprise",
    name: "Enterprise",
    description: "For companies that need governance, custom limits, and dedicated support.",
    priceMonthlyCents: 14900,
    priceYearlyCents: 149000,
    maxUsers: null,
    maxHosts: null,
    maxConcurrentSessions: null,
    auditRetentionDays: 365,
    displayOrder: 3,
    features: ["Everything in Business", "Unlimited hosts", "Custom retention", "SAML/OIDC ready", "Dedicated success"]
  }
];

async function main() {
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const organization = await prisma.organization.upsert({
    where: { slug: "onshell-cloud" },
    update: { name: "Onshell.cloud" },
    create: {
      name: "Onshell.cloud",
      slug: "onshell-cloud"
    }
  });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: "Latifur Admin",
      passwordHash,
      isPlatformAdmin: true,
      twoFactorEnabled: false
    },
    create: {
      email: adminEmail,
      name: "Latifur Admin",
      passwordHash,
      isPlatformAdmin: true,
      twoFactorEnabled: false
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

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan
    });
  }

  const businessPlan = await prisma.plan.findUniqueOrThrow({
    where: { code: "business" }
  });

  const currentPeriodStart = new Date();
  const currentPeriodEnd = new Date(currentPeriodStart);
  currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);

  await prisma.subscription.upsert({
    where: { id: "seed_onshell_business_subscription" },
    update: {
      planId: businessPlan.id,
      status: "ACTIVE",
      billingInterval: "MONTHLY",
      currentPeriodStart,
      currentPeriodEnd
    },
    create: {
      id: "seed_onshell_business_subscription",
      organizationId: organization.id,
      planId: businessPlan.id,
      status: "ACTIVE",
      billingInterval: "MONTHLY",
      currentPeriodStart,
      currentPeriodEnd
    }
  });

  await prisma.smtpSetting.upsert({
    where: { id: "global" },
    update: {
      fromEmail: "noreply@onshell.cloud",
      fromName: "Onshell.cloud",
      updatedById: admin.id
    },
    create: {
      id: "global",
      host: "smtp.example.com",
      port: 465,
      secure: true,
      fromEmail: "noreply@onshell.cloud",
      fromName: "Onshell.cloud",
      enabled: false,
      updatedById: admin.id
    }
  });

  await prisma.appSetting.upsert({
    where: { key: "platform.brand" },
    update: {
      value: {
        name: "Onshell.cloud",
        domain: "onshell.cloud",
        supportEmail: "support@onshell.cloud"
      },
      updatedById: admin.id
    },
    create: {
      key: "platform.brand",
      category: "platform",
      value: {
        name: "Onshell.cloud",
        domain: "onshell.cloud",
        supportEmail: "support@onshell.cloud"
      },
      updatedById: admin.id
    }
  });

  await prisma.paymentSetting.upsert({
    where: {
      provider_mode: {
        provider: "STRIPE",
        mode: "test"
      }
    },
    update: {
      enabled: false
    },
    create: {
      provider: "STRIPE",
      mode: "test",
      enabled: false
    }
  });

  console.log(`Seeded Onshell.cloud admin: ${adminEmail}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

