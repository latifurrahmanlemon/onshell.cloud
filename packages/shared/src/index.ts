export const roles = ["owner", "admin", "devops", "developer", "auditor"] as const;
export type Role = (typeof roles)[number];

export const hostTypes = ["ssh", "rdp", "vnc"] as const;
export type HostType = (typeof hostTypes)[number];

export const environments = ["production", "staging", "development"] as const;
export type Environment = (typeof environments)[number];

export const sessionProtocols = ["ssh", "sftp", "rdp", "vnc", "tunnel"] as const;
export type SessionProtocol = (typeof sessionProtocols)[number];

export const sessionStatuses = ["pending", "active", "closed", "failed"] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

export const billingIntervals = ["monthly", "yearly"] as const;
export type BillingInterval = (typeof billingIntervals)[number];

export const subscriptionStatuses = ["trialing", "active", "past_due", "canceled", "expired"] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  organizationId: string;
  isPlatformAdmin: boolean;
  emailVerifiedAt?: string;
  authMethods?: Array<"password" | "google">;
  twoFactorEnabled: boolean;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Host {
  id: string;
  organizationId: string;
  name: string;
  type: HostType;
  address: string;
  port: number;
  username?: string;
  environment: Environment;
  tags: string[];
  group?: string;
  notes?: string;
  health: "unknown" | "online" | "degraded" | "offline";
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSummary {
  id: string;
  organizationId: string;
  name: string;
  kind: "password" | "ssh_key" | "rdp_password";
  attachedHostIds: string[];
  rotatedAt?: string;
  createdAt: string;
}

export interface RemoteSession {
  id: string;
  organizationId: string;
  hostId: string;
  userId: string;
  protocol: SessionProtocol;
  status: SessionStatus;
  startedAt: string;
  endedAt?: string;
  gatewaySessionId?: string;
}

export interface AuditLog {
  id: string;
  organizationId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface Snippet {
  id: string;
  organizationId: string;
  ownerId: string;
  name: string;
  command: string;
  scope: "personal" | "team" | "host";
  hostId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  maxUsers?: number;
  maxHosts?: number;
  maxConcurrentSessions?: number;
  auditRetentionDays: number;
  features: string[];
  isActive: boolean;
  displayOrder: number;
}

export interface Subscription {
  id: string;
  organizationId: string;
  planId: string;
  planName: string;
  status: SubscriptionStatus;
  billingInterval: BillingInterval;
  currentPeriodEnd: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  fromEmail: string;
  fromName: string;
  enabled: boolean;
  testRecipient?: string;
  updatedAt: string;
}

const privilegedRoles: Role[] = ["owner", "admin", "devops"];

export function canManageUsers(role: Role) {
  return role === "owner" || role === "admin";
}

export function canManageHosts(role: Role) {
  return privilegedRoles.includes(role);
}

export function canOpenSession(role: Role) {
  return role !== "auditor";
}

export function canEditFiles(role: Role) {
  return role === "owner" || role === "admin" || role === "devops";
}

export function canManagePlatform(user: Pick<User, "isPlatformAdmin" | "role">) {
  return user.isPlatformAdmin || user.role === "owner";
}

export function normalizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
