import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadConfig, type RuntimeConfig } from "@onshell/config";
import { canManageUsers, validatePassword } from "@onshell/shared";
import type { Role as PublicRole } from "@onshell/shared";
import prismaPkg from "@prisma/client";
const { Role } = prismaPkg;
type Role = (typeof Role)[keyof typeof Role];
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { sendTransactionalEmail } from "../../lib/email.js";
import {
  hasImplicitHostAccess,
  hostAccessSummaries,
  replaceHostAccess
} from "../../lib/host-access.js";
import { prisma } from "../../lib/prisma.js";
import { revokeRefreshTokens } from "../../lib/refresh-tokens.js";
import { toPublicUser } from "../../lib/prisma-mappers.js";
import { generateReferralCode } from "../../lib/provisioning.js";
import { handleRouteError } from "../../lib/reply.js";
import { hashToken } from "../../lib/token.js";
import { createAudit, issueTokens } from "./auth.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const roleToPrisma: Record<PublicRole, Role> = {
  owner: Role.OWNER,
  admin: Role.ADMIN,
  devops: Role.DEVOPS,
  developer: Role.DEVELOPER,
  auditor: Role.AUDITOR
};

const roleToPublic: Record<Role, PublicRole> = {
  OWNER: "owner",
  ADMIN: "admin",
  DEVOPS: "devops",
  DEVELOPER: "developer",
  AUDITOR: "auditor"
};

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "devops", "developer", "auditor"])
});

const invitationParamsSchema = z.object({
  invitationId: z.string()
});

const acceptInvitationSchema = z.object({
  token: z.string().min(16),
  name: z.string().min(2).optional(),
  password: z.string().optional()
});

const memberParamsSchema = z.object({
  userId: z.string()
});

const updateMemberSchema = z.object({
  role: z.enum(["owner", "admin", "devops", "developer", "auditor"])
});

const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120)
});

const hostAccessSchema = z
  .object({
    allHosts: z.boolean(),
    hostIds: z.array(z.string().min(1)).max(500).default([])
  })
  // "All hosts" and a host list are alternatives, not a combination — refusing
  // both at once keeps the caller from thinking the list narrowed the grant.
  .refine((body) => !body.allHosts || body.hostIds.length === 0, {
    message: "hostIds must be empty when allHosts is true",
    path: ["hostIds"]
  });

function toInvitationSummary(invitation: {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  createdAt: Date;
}) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: roleToPublic[invitation.role],
    status: "pending" as const,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString()
  };
}

async function countOwners(organizationId: string) {
  return prisma.organizationMember.count({
    where: { organizationId, role: Role.OWNER }
  });
}

export async function registerOrganizationRoutes(
  app: FastifyInstance,
  config: RuntimeConfig = loadConfig("api")
) {
  app.get("/organizations/current", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const organization = await prisma.organization.findUnique({
        where: { id: user.organizationId }
      });
      if (!organization) return reply.code(404).send({ error: "organization_not_found" });

      const memberships = await prisma.organizationMember.findMany({
        where: { organizationId: organization.id },
        include: { user: true },
        orderBy: { createdAt: "asc" }
      });

      // Bundled in rather than fetched per row: the team panel renders an access
      // summary for every member, which would otherwise be an N+1 of requests.
      const accessSummaries = await hostAccessSummaries(
        organization.id,
        memberships.map((membership) => ({
          userId: membership.userId,
          role: roleToPublic[membership.role]
        }))
      );

      return {
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt.toISOString()
        },
        members: memberships.map((membership) => ({
          id: membership.userId,
          name: membership.user.name,
          email: membership.user.email,
          avatarUrl: membership.user.avatarUrl ?? null,
          role: roleToPublic[membership.role],
          joinedAt: membership.createdAt.toISOString(),
          twoFactorEnabled: membership.user.twoFactorEnabled,
          hostAccess: accessSummaries.get(membership.userId) ?? {
            allHosts: false,
            hostIds: [],
            implicit: false
          }
        }))
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/organizations/current", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageUsers(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const body = updateOrganizationSchema.parse(request.body);
      const organization = await prisma.organization.update({
        where: { id: actor.organizationId },
        data: { name: body.name }
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "organization.update",
        targetType: "organization",
        targetId: organization.id,
        ipAddress: request.ip,
        metadata: { name: body.name }
      });

      return {
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt.toISOString()
        }
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/organizations/current/invitations", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageUsers(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const body = inviteSchema.parse(request.body);
      const existingUser = await prisma.user.findUnique({
        where: { email: body.email },
        include: { memberships: true }
      });
      if (existingUser?.memberships.some((membership) => membership.organizationId === actor.organizationId)) {
        return reply.code(409).send({ error: "already_a_member" });
      }

      const pendingInvitation = await prisma.invitation.findFirst({
        where: {
          organizationId: actor.organizationId,
          email: body.email,
          acceptedAt: null,
          expiresAt: { gt: new Date() }
        }
      });
      if (pendingInvitation) return reply.code(409).send({ error: "invitation_already_pending" });

      const token = randomBytes(32).toString("base64url");
      const invitation = await prisma.invitation.create({
        data: {
          organizationId: actor.organizationId,
          email: body.email,
          role: roleToPrisma[body.role],
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS)
        }
      });

      const acceptUrl = `${config.publicBaseUrl}/invite?token=${token}`;
      const organization = await prisma.organization.findUnique({
        where: { id: actor.organizationId }
      });
      const emailSent = await sendTransactionalEmail({
        masterEncryptionKey: config.masterEncryptionKey,
        recipient: body.email,
        subject: `You have been invited to ${organization?.name ?? "Onshell.cloud"}`,
        text: `${actor.name} invited you to join ${organization?.name ?? "their workspace"} on Onshell.cloud as ${body.role}. Accept the invitation: ${acceptUrl} (link expires in 7 days).`,
        html: `<p><strong>${actor.name}</strong> invited you to join <strong>${organization?.name ?? "their workspace"}</strong> on Onshell.cloud as <strong>${body.role}</strong>.</p><p><a href="${acceptUrl}">Accept the invitation</a> (link expires in 7 days).</p>`,
        kind: "organization_invitation",
        logger: app.log
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "organization.invitation.create",
        targetType: "invitation",
        targetId: invitation.id,
        ipAddress: request.ip,
        metadata: { email: body.email, role: body.role, emailSent }
      });

      return reply.code(201).send({
        ...toInvitationSummary(invitation),
        emailSent,
        acceptUrl
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/organizations/current/invitations", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageUsers(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const invitations = await prisma.invitation.findMany({
        where: {
          organizationId: actor.organizationId,
          acceptedAt: null,
          expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: "desc" }
      });

      return { invitations: invitations.map(toInvitationSummary) };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/organizations/current/invitations/:invitationId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageUsers(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const params = invitationParamsSchema.parse(request.params);
      const invitation = await prisma.invitation.findFirst({
        where: { id: params.invitationId, organizationId: actor.organizationId }
      });
      if (!invitation) return reply.code(404).send({ error: "invitation_not_found" });

      await prisma.invitation.delete({ where: { id: invitation.id } });
      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "organization.invitation.revoke",
        targetType: "invitation",
        targetId: invitation.id,
        ipAddress: request.ip,
        metadata: { email: invitation.email }
      });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/invitations/accept", async (request, reply) => {
    try {
      const body = acceptInvitationSchema.parse(request.body);
      const invitation = await prisma.invitation.findFirst({
        where: { tokenHash: hashToken(body.token) }
      });
      if (!invitation || invitation.acceptedAt || invitation.expiresAt.getTime() <= Date.now()) {
        return reply.code(400).send({ error: "invalid_or_expired_invitation" });
      }

      const existingUser = await prisma.user.findUnique({
        where: { email: invitation.email },
        include: { memberships: true }
      });

      if (existingUser) {
        const alreadyMember = existingUser.memberships.some(
          (membership) => membership.organizationId === invitation.organizationId
        );

        await prisma.$transaction(async (tx) => {
          if (!alreadyMember) {
            await tx.organizationMember.create({
              data: {
                organizationId: invitation.organizationId,
                userId: existingUser.id,
                role: invitation.role
              }
            });
          }
          await tx.invitation.update({
            where: { id: invitation.id },
            data: { acceptedAt: new Date() }
          });
        });

        await createAudit({
          organizationId: invitation.organizationId,
          actorId: existingUser.id,
          action: "organization.invitation.accept",
          targetType: "invitation",
          targetId: invitation.id,
          ipAddress: request.ip,
          metadata: { email: invitation.email, existingUser: true }
        });

        return {
          accepted: true,
          existingUser: true,
          requiresLogin: true,
          organizationId: invitation.organizationId
        };
      }

      if (!body.name || !body.password) {
        return reply.code(400).send({ error: "name_and_password_required" });
      }

      const passwordCheck = validatePassword(body.password);
      if (!passwordCheck.valid) {
        return reply.code(400).send({ error: "password_policy_violation", errors: passwordCheck.errors });
      }

      const passwordHash = await bcrypt.hash(body.password, 12);
      // Invited members get a referral code too, so anyone on the platform can
      // share Onshell — not just people who signed up through the public form.
      const referralCode = await generateReferralCode();
      const prismaUser = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            name: body.name!,
            email: invitation.email,
            passwordHash,
            referralCode,
            memberships: {
              create: {
                organizationId: invitation.organizationId,
                role: invitation.role
              }
            }
          },
          include: { memberships: true }
        });

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() }
        });

        return createdUser;
      });

      const user = { ...toPublicUser(prismaUser), authMethods: ["password" as const] };
      await createAudit({
        organizationId: invitation.organizationId,
        actorId: user.id,
        action: "organization.invitation.accept",
        targetType: "invitation",
        targetId: invitation.id,
        ipAddress: request.ip,
        metadata: { email: invitation.email, existingUser: false }
      });

      return reply.code(201).send(await issueTokens(reply, config, user, request));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.patch("/organizations/current/members/:userId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageUsers(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const params = memberParamsSchema.parse(request.params);
      const body = updateMemberSchema.parse(request.body);
      const membership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: actor.organizationId,
            userId: params.userId
          }
        }
      });
      if (!membership) return reply.code(404).send({ error: "member_not_found" });

      const newRole = roleToPrisma[body.role];
      if ((membership.role === Role.OWNER || newRole === Role.OWNER) && actor.role !== "owner") {
        return reply.code(403).send({ error: "owner_role_requires_owner" });
      }

      if (membership.role === Role.OWNER && newRole !== Role.OWNER) {
        if ((await countOwners(actor.organizationId)) <= 1) {
          return reply.code(409).send({ error: "cannot_demote_last_owner" });
        }
      }

      await prisma.organizationMember.update({
        where: { id: membership.id },
        data: { role: newRole }
      });

      // Promotion to owner/admin makes stored grants unreadable dead rows; drop
      // them so a later demotion starts from "no access" rather than from a
      // stale grant set nobody remembers approving.
      if (hasImplicitHostAccess(body.role)) {
        await prisma.hostAccessGrant.deleteMany({
          where: { organizationId: actor.organizationId, userId: params.userId }
        });
      }

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "organization.member.role_change",
        targetType: "organization_member",
        targetId: params.userId,
        ipAddress: request.ip,
        metadata: { from: roleToPublic[membership.role], to: body.role }
      });

      return { id: params.userId, role: body.role };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/organizations/current/members/:userId/host-access", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageUsers(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const params = memberParamsSchema.parse(request.params);
      const membership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: actor.organizationId,
            userId: params.userId
          }
        }
      });
      if (!membership) return reply.code(404).send({ error: "member_not_found" });

      const summaries = await hostAccessSummaries(actor.organizationId, [
        { userId: params.userId, role: roleToPublic[membership.role] }
      ]);

      return summaries.get(params.userId) ?? { allHosts: false, hostIds: [], implicit: false };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.put("/organizations/current/members/:userId/host-access", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageUsers(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const params = memberParamsSchema.parse(request.params);
      const body = hostAccessSchema.parse(request.body);
      const membership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: actor.organizationId,
            userId: params.userId
          }
        }
      });
      if (!membership) return reply.code(404).send({ error: "member_not_found" });

      // Owners and admins reach every host by role, so storing grants for them
      // would only pretend to restrict something. Reject loudly instead of
      // writing rows that nothing reads.
      if (hasImplicitHostAccess(roleToPublic[membership.role])) {
        return reply.code(409).send({ error: "member_has_implicit_host_access" });
      }

      if (body.hostIds.length > 0) {
        const owned = await prisma.host.count({
          where: { organizationId: actor.organizationId, id: { in: body.hostIds } }
        });
        if (owned !== new Set(body.hostIds).size) {
          return reply.code(400).send({ error: "invalid_host_ids" });
        }
      }

      const summary = await replaceHostAccess({
        organizationId: actor.organizationId,
        userId: params.userId,
        grantedById: actor.id,
        allHosts: body.allHosts,
        hostIds: body.hostIds
      });

      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "organization.member.host_access",
        targetType: "organization_member",
        targetId: params.userId,
        ipAddress: request.ip,
        metadata: { allHosts: summary.allHosts, hostIds: summary.hostIds }
      });

      return summary;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/organizations/current/members/:userId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageUsers(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const params = memberParamsSchema.parse(request.params);
      const membership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: actor.organizationId,
            userId: params.userId
          }
        }
      });
      if (!membership) return reply.code(404).send({ error: "member_not_found" });

      if (membership.role === Role.OWNER) {
        if (actor.role !== "owner") {
          return reply.code(403).send({ error: "owner_role_requires_owner" });
        }
        if ((await countOwners(actor.organizationId)) <= 1) {
          return reply.code(409).send({ error: "cannot_remove_last_owner" });
        }
      }

      await prisma.$transaction([
        prisma.organizationMember.delete({ where: { id: membership.id } }),
        revokeRefreshTokens({ userId: params.userId })
      ]);
      await createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "organization.member.remove",
        targetType: "organization_member",
        targetId: params.userId,
        ipAddress: request.ip
      });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
