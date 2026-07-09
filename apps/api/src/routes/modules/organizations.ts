import type { FastifyInstance } from "fastify";
import { canManageUsers } from "@onshell/shared";
import { z } from "zod";
import { getCurrentUser } from "../../lib/current-user.js";
import { handleRouteError } from "../../lib/reply.js";
import { createAudit, store } from "../../lib/store.js";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "devops", "developer", "auditor"])
});

export async function registerOrganizationRoutes(app: FastifyInstance) {
  app.get("/organizations/current", async (request) => {
    const user = getCurrentUser(request);
    const organization = store.organizations.find((item) => item.id === user.organizationId);
    const members = store.users.filter((member) => member.organizationId === user.organizationId);

    return {
      organization,
      members
    };
  });

  app.post("/organizations/current/invitations", async (request, reply) => {
    try {
      const actor = getCurrentUser(request);
      if (!canManageUsers(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = inviteSchema.parse(request.body);
      createAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "organization.invite",
        targetType: "invitation",
        ipAddress: request.ip,
        metadata: body
      });

      return reply.code(201).send({
        id: `inv_${Date.now()}`,
        email: body.email,
        role: body.role,
        status: "pending"
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}

