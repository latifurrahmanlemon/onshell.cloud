import type {
  AuditLog as PrismaAuditLog,
  Credential as PrismaCredential,
  Host as PrismaHost,
  HostGroup as PrismaHostGroup,
  HostTag as PrismaHostTag,
  OrganizationMember,
  Prisma,
  Session as PrismaSession,
  Snippet as PrismaSnippet,
  User as PrismaUser
} from "@prisma/client";
import type {
  AuditLog,
  CredentialSummary,
  Environment,
  Host,
  HostType,
  RemoteSession,
  Role,
  SessionProtocol,
  SessionStatus,
  Snippet,
  User
} from "@onshell/shared";
import { prisma } from "./prisma.js";

const roleMap: Record<OrganizationMember["role"], Role> = {
  OWNER: "owner",
  ADMIN: "admin",
  DEVOPS: "devops",
  DEVELOPER: "developer",
  AUDITOR: "auditor"
};

export const hostTypeToPrisma: Record<HostType, PrismaHost["type"]> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC"
};

const hostTypeFromPrisma: Record<PrismaHost["type"], HostType> = {
  SSH: "ssh",
  RDP: "rdp",
  VNC: "vnc"
};

export const environmentToPrisma: Record<Environment, PrismaHost["environment"]> = {
  production: "PRODUCTION",
  staging: "STAGING",
  development: "DEVELOPMENT"
};

const environmentFromPrisma: Record<PrismaHost["environment"], Environment> = {
  PRODUCTION: "production",
  STAGING: "staging",
  DEVELOPMENT: "development"
};

export const credentialKindToPrisma: Record<CredentialSummary["kind"], PrismaCredential["kind"]> = {
  password: "PASSWORD",
  ssh_key: "SSH_KEY",
  rdp_password: "RDP_PASSWORD"
};

export const credentialKindFromPrisma: Record<PrismaCredential["kind"], CredentialSummary["kind"]> = {
  PASSWORD: "password",
  SSH_KEY: "ssh_key",
  RDP_PASSWORD: "rdp_password"
};

export const sessionProtocolToPrisma: Record<SessionProtocol, PrismaSession["protocol"]> = {
  ssh: "SSH",
  sftp: "SFTP",
  rdp: "RDP",
  vnc: "VNC",
  tunnel: "TUNNEL"
};

export const sessionProtocolFromPrisma: Record<PrismaSession["protocol"], SessionProtocol> = {
  SSH: "ssh",
  SFTP: "sftp",
  RDP: "rdp",
  VNC: "vnc",
  TUNNEL: "tunnel"
};

const sessionStatusFromPrisma: Record<PrismaSession["status"], SessionStatus> = {
  PENDING: "pending",
  ACTIVE: "active",
  CLOSED: "closed",
  FAILED: "failed"
};

export type UserWithMembership = PrismaUser & {
  memberships: OrganizationMember[];
};

export function toPublicUser(user: UserWithMembership): User {
  const membership = user.memberships[0];
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: membership ? roleMap[membership.role] : "developer",
    organizationId: membership?.organizationId ?? "",
    isPlatformAdmin: user.isPlatformAdmin,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString(),
    authMethods: [],
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt.toISOString()
  };
}

export type HostWithRelations = PrismaHost & {
  tags: PrismaHostTag[];
  group: PrismaHostGroup | null;
};

export function toHost(host: HostWithRelations): Host {
  return {
    id: host.id,
    organizationId: host.organizationId,
    name: host.name,
    type: hostTypeFromPrisma[host.type],
    address: host.address,
    port: host.port,
    username: host.username ?? undefined,
    environment: environmentFromPrisma[host.environment],
    tags: host.tags.map((tag) => tag.name),
    group: host.group?.name,
    notes: host.notes ?? undefined,
    health: host.health as Host["health"],
    createdAt: host.createdAt.toISOString(),
    updatedAt: host.updatedAt.toISOString()
  };
}

export type CredentialWithHosts = PrismaCredential & {
  hosts: Array<{ id: string }>;
};

export function toCredentialSummary(credential: CredentialWithHosts): CredentialSummary {
  return {
    id: credential.id,
    organizationId: credential.organizationId,
    name: credential.name,
    kind: credentialKindFromPrisma[credential.kind],
    attachedHostIds: credential.hosts.map((host) => host.id),
    rotatedAt: credential.rotatedAt?.toISOString(),
    createdAt: credential.createdAt.toISOString()
  };
}

export function toRemoteSession(session: PrismaSession): RemoteSession {
  return {
    id: session.id,
    organizationId: session.organizationId,
    hostId: session.hostId,
    userId: session.userId,
    protocol: sessionProtocolFromPrisma[session.protocol],
    status: sessionStatusFromPrisma[session.status],
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString(),
    gatewaySessionId: session.gatewaySessionId ?? undefined
  };
}

export function toSnippet(snippet: PrismaSnippet): Snippet {
  return {
    id: snippet.id,
    organizationId: snippet.organizationId,
    ownerId: snippet.ownerId,
    name: snippet.name,
    command: snippet.command,
    scope: snippet.scope as Snippet["scope"],
    hostId: snippet.hostId ?? undefined,
    createdAt: snippet.createdAt.toISOString(),
    updatedAt: snippet.updatedAt.toISOString()
  };
}

export function toAuditLog(log: PrismaAuditLog): AuditLog {
  return {
    id: log.id,
    organizationId: log.organizationId,
    actorId: log.actorId,
    action: log.action,
    targetType: log.targetType,
    targetId: log.targetId ?? undefined,
    ipAddress: log.ipAddress ?? undefined,
    metadata: (log.metadata as Record<string, unknown> | null) ?? undefined,
    createdAt: log.createdAt.toISOString()
  };
}

export interface AuditInput {
  organizationId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput) {
  await prisma.auditLog.create({
    data: {
      ...input,
      metadata: input.metadata as Prisma.InputJsonValue | undefined
    }
  });
}
