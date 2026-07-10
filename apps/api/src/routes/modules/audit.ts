import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { toAuditLog } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().optional(),
  search: z.string().optional()
});

export async function registerAuditRoutes(app: FastifyInstance) {
  app.get("/audit", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const query = auditQuerySchema.parse(request.query);
      const logs = await prisma.auditLog.findMany({
        where: {
          organizationId: user.organizationId,
          ...(query.action && { action: { contains: query.action } }),
          ...(query.search && {
            OR: [
              { action: { contains: query.search } },
              { targetType: { contains: query.search } },
              { targetId: { contains: query.search } }
            ]
          })
        },
        orderBy: { createdAt: "desc" },
        take: query.limit
      });

      return logs.map(toAuditLog);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
