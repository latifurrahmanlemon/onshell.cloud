import type { OrganizationMember, User as PrismaUser } from "@prisma/client";
import type { Role, User } from "@onshell/shared";

const roleMap: Record<OrganizationMember["role"], Role> = {
  OWNER: "owner",
  ADMIN: "admin",
  DEVOPS: "devops",
  DEVELOPER: "developer",
  AUDITOR: "auditor"
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

