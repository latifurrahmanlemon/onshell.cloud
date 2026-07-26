import type { Role } from "@onshell/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

/** `HostAccessGrant.scopeKey` value standing in for the org-wide grant. */
export const ALL_HOSTS_SCOPE_KEY = "*";

/**
 * Roles that bypass `HostAccessGrant` and always reach every host in their own
 * organization.
 *
 * `owner` is non-negotiable: an admin must not be able to lock the last owner
 * out of the hosts they pay for. `admin` is included because `canManageUsers`
 * already lets admins write grants — an admin denied a host could hand it to
 * themselves in one request, so enforcing the table against them would be
 * security theatre rather than a boundary, while costing a confusing failure
 * mode ("I can manage access but not use it"). Grants therefore govern exactly
 * `devops`, `developer` and `auditor`.
 */
const IMPLICIT_ALL_HOSTS_ROLES: readonly Role[] = ["owner", "admin"];

export function hasImplicitHostAccess(role: Role) {
  return IMPLICIT_ALL_HOSTS_ROLES.includes(role);
}

/** One member's effective host access, as rendered by the team panel. */
export interface HostAccessSummary {
  /** Reaches every host in the organization, now and in future. */
  allHosts: boolean;
  /** Individually granted host ids. Empty when `allHosts` is true. */
  hostIds: string[];
  /** True when `allHosts` comes from the role rather than a stored grant. */
  implicit: boolean;
}

/**
 * Prisma `where` fragment narrowing a Host query to what this user may reach.
 *
 * Callers spread it into their own `where` so the database does the filtering —
 * no route ever loads hosts and then discards them, which is what keeps the
 * pagination, counts and search in the hosts list honest.
 */
export async function accessibleHostFilter(
  userId: string,
  role: Role,
  organizationId: string
): Promise<Prisma.HostWhereInput> {
  if (hasImplicitHostAccess(role)) return { organizationId };

  // The org-wide grant carries no hostId, so it cannot be expressed as a
  // relation filter on Host — one indexed lookup decides which shape to return.
  const orgWide = await prisma.hostAccessGrant.findFirst({
    where: { organizationId, userId, allHosts: true },
    select: { id: true }
  });
  if (orgWide) return { organizationId };

  return { organizationId, accessGrants: { some: { userId } } };
}

/** True when the user may open, read or manage the given host. */
export async function canAccessHost(
  userId: string,
  role: Role,
  organizationId: string,
  hostId: string
): Promise<boolean> {
  const filter = await accessibleHostFilter(userId, role, organizationId);
  const host = await prisma.host.findFirst({
    where: { ...filter, id: hostId },
    select: { id: true }
  });
  return host !== null;
}

/** Returns the subset of `hostIds` the user may reach, in one query. */
export async function accessibleHostIds(
  userId: string,
  role: Role,
  organizationId: string,
  hostIds: string[]
): Promise<Set<string>> {
  if (hostIds.length === 0) return new Set();
  const filter = await accessibleHostFilter(userId, role, organizationId);
  const hosts = await prisma.host.findMany({
    where: { ...filter, id: { in: hostIds } },
    select: { id: true }
  });
  return new Set(hosts.map((host) => host.id));
}

/**
 * Access summaries for several members at once, so the organization payload can
 * carry them without a request per row.
 */
export async function hostAccessSummaries(
  organizationId: string,
  members: Array<{ userId: string; role: Role }>
): Promise<Map<string, HostAccessSummary>> {
  const governed = members.filter((member) => !hasImplicitHostAccess(member.role));
  const grants = governed.length
    ? await prisma.hostAccessGrant.findMany({
        where: { organizationId, userId: { in: governed.map((member) => member.userId) } },
        select: { userId: true, hostId: true, allHosts: true }
      })
    : [];

  const summaries = new Map<string, HostAccessSummary>(
    members.map((member) => [
      member.userId,
      hasImplicitHostAccess(member.role)
        ? { allHosts: true, hostIds: [], implicit: true }
        : { allHosts: false, hostIds: [], implicit: false }
    ])
  );

  for (const grant of grants) {
    const summary = summaries.get(grant.userId);
    if (!summary) continue;
    if (grant.allHosts) summary.allHosts = true;
    else if (grant.hostId) summary.hostIds.push(grant.hostId);
  }

  return summaries;
}

/**
 * Replaces a member's grants wholesale. Rewriting rather than diffing keeps the
 * "all hosts" and "these hosts" states mutually exclusive, which the unique
 * index on `scopeKey` would otherwise only catch as a constraint error.
 */
export async function replaceHostAccess(input: {
  organizationId: string;
  userId: string;
  grantedById: string;
  allHosts: boolean;
  hostIds: string[];
}): Promise<HostAccessSummary> {
  const hostIds = input.allHosts ? [] : [...new Set(input.hostIds)];

  await prisma.$transaction([
    prisma.hostAccessGrant.deleteMany({
      where: { organizationId: input.organizationId, userId: input.userId }
    }),
    prisma.hostAccessGrant.createMany({
      data: input.allHosts
        ? [
            {
              organizationId: input.organizationId,
              userId: input.userId,
              hostId: null,
              allHosts: true,
              scopeKey: ALL_HOSTS_SCOPE_KEY,
              grantedById: input.grantedById
            }
          ]
        : hostIds.map((hostId) => ({
            organizationId: input.organizationId,
            userId: input.userId,
            hostId,
            allHosts: false,
            scopeKey: hostId,
            grantedById: input.grantedById
          }))
    })
  ]);

  return { allHosts: input.allHosts, hostIds, implicit: false };
}
