import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { AuditLog, CredentialSummary, Host, Organization, Plan, RemoteSession, SmtpSettings, Snippet, Subscription, User } from "@onshell/shared";

const createdAt = new Date().toISOString();

export const store: {
  organizations: Organization[];
  users: User[];
  hosts: Host[];
  credentials: CredentialSummary[];
  sessions: RemoteSession[];
  auditLogs: AuditLog[];
  snippets: Snippet[];
  plans: Plan[];
  subscriptions: Subscription[];
  smtpSettings: SmtpSettings;
  appSettings: Record<string, unknown>;
  paymentSettings: Array<{
    provider: "stripe" | "paddle" | "ssl_commerz" | "manual";
    mode: "test" | "live";
    publicKey?: string;
    enabled: boolean;
  }>;
  authProfiles: Array<{
    userId: string;
    passwordHash?: string;
    totpSecret?: string;
    googleSubject?: string;
    googleEmail?: string;
  }>;
  pendingTwoFactorSetups: Record<string, string>;
  pendingTwoFactorChallenges: Record<
    string,
    {
      userId: string;
      createdAt: string;
      method?: "totp" | "email";
      emailOtpHash?: string;
      emailOtpExpiresAt?: string;
      lastEmailSentAt?: string;
      attempts?: number;
    }
  >;
  googleOAuthStates: Record<string, { createdAt: string; returnTo: string }>;
} = {
  organizations: [
    {
      id: "org_onshell",
      name: "Onshell.cloud",
      slug: "onshell-cloud",
      createdAt
    }
  ],
  users: [
    {
      id: "user_latifur_admin",
      name: "Latifur Admin",
      email: "latifur.tech@gmial.com",
      role: "owner",
      organizationId: "org_onshell",
      isPlatformAdmin: true,
      emailVerifiedAt: createdAt,
      authMethods: ["password"],
      twoFactorEnabled: false,
      createdAt
    },
    {
      id: "user_owner",
      name: "Onshell Owner",
      email: "owner@onshell.cloud",
      role: "owner",
      organizationId: "org_onshell",
      isPlatformAdmin: true,
      emailVerifiedAt: createdAt,
      authMethods: ["password"],
      twoFactorEnabled: true,
      createdAt
    }
  ],
  hosts: [
    {
      id: "host_prod_bastion",
      organizationId: "org_onshell",
      name: "Production Bastion",
      type: "ssh",
      address: "10.20.0.10",
      port: 22,
      username: "deploy",
      environment: "production",
      tags: ["linux", "bastion"],
      group: "Core",
      health: "online",
      notes: "Primary jump host for production SSH access.",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "host_finance_rdp",
      organizationId: "org_onshell",
      name: "Finance RDP",
      type: "rdp",
      address: "10.20.4.12",
      port: 3389,
      username: "ops-admin",
      environment: "production",
      tags: ["windows", "rdp"],
      group: "Operations",
      health: "degraded",
      notes: "Requires approval for clipboard access.",
      createdAt,
      updatedAt: createdAt
    }
  ],
  credentials: [
    {
      id: "cred_prod_key",
      organizationId: "org_onshell",
      name: "Prod Deploy Key",
      kind: "ssh_key",
      attachedHostIds: ["host_prod_bastion"],
      rotatedAt: createdAt,
      lastUsedAt: createdAt,
      createdAt,
      updatedAt: createdAt
    }
  ],
  sessions: [],
  auditLogs: [],
  snippets: [
    {
      id: "snippet_release_status",
      organizationId: "org_onshell",
      ownerId: "user_owner",
      name: "Release Status",
      command: "systemctl status onshell-api --no-pager",
      scope: "team",
      createdAt,
      updatedAt: createdAt
    }
  ],
  plans: [
    {
      id: "plan_starter",
      code: "starter",
      name: "Starter",
      description: "Secure browser SSH and SFTP for small teams.",
      priceMonthlyCents: 1900,
      priceYearlyCents: 19000,
      currency: "USD",
      maxUsers: 5,
      maxHosts: 20,
      maxConcurrentSessions: 5,
      auditRetentionDays: 30,
      features: ["SSH terminal", "SFTP file manager", "Credential vault", "30-day audit logs"],
      isActive: true,
      displayOrder: 1
    },
    {
      id: "plan_business",
      code: "business",
      name: "Business",
      description: "RDP, snippets, and audit controls for growing DevOps teams.",
      priceMonthlyCents: 4900,
      priceYearlyCents: 49000,
      currency: "USD",
      maxUsers: 25,
      maxHosts: 150,
      maxConcurrentSessions: 25,
      auditRetentionDays: 180,
      features: ["Everything in Starter", "Browser RDP", "Team snippets", "180-day audit logs", "Priority support"],
      isActive: true,
      displayOrder: 2
    },
    {
      id: "plan_enterprise",
      code: "enterprise",
      name: "Enterprise",
      description: "Governance, custom limits, and dedicated success for larger companies.",
      priceMonthlyCents: 14900,
      priceYearlyCents: 149000,
      currency: "USD",
      auditRetentionDays: 365,
      features: ["Everything in Business", "Unlimited hosts", "Custom retention", "SAML/OIDC ready", "Dedicated success"],
      isActive: true,
      displayOrder: 3
    }
  ],
  subscriptions: [
    {
      id: "sub_onshell_business",
      organizationId: "org_onshell",
      planId: "plan_business",
      planName: "Business",
      status: "active",
      billingInterval: "monthly",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }
  ],
  smtpSettings: {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    username: "noreply@onshell.cloud",
    fromEmail: "noreply@onshell.cloud",
    fromName: "Onshell.cloud",
    enabled: false,
    testRecipient: "admin@onshell.cloud",
    updatedAt: createdAt
  },
  appSettings: {
    "platform.brand": {
      name: "Onshell.cloud",
      domain: "onshell.cloud",
      supportEmail: "support@onshell.cloud"
    },
    "billing.trialDays": 14,
    "security.requireTwoFactorForAdmins": true
  },
  paymentSettings: [
    {
      provider: "stripe",
      mode: "test",
      enabled: false
    }
  ],
  authProfiles: [
    {
      userId: "user_latifur_admin",
      passwordHash: bcrypt.hashSync("Lemon553&", 12)
    },
    {
      userId: "user_owner",
      passwordHash: bcrypt.hashSync("Lemon553&", 12),
      totpSecret: "N4NZA6PNPKWMCYY4MS7QKR2KAMO36OAU"
    }
  ],
  pendingTwoFactorSetups: {},
  pendingTwoFactorChallenges: {},
  googleOAuthStates: {}
};

export function createAudit(input: Omit<AuditLog, "id" | "createdAt">) {
  const auditLog: AuditLog = {
    id: `audit_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };

  store.auditLogs.unshift(auditLog);
  return auditLog;
}
