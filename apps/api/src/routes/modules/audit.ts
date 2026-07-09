import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCurrentUser } from "../../lib/current-user.js";
import { store } from "../../lib/store.js";

export async function registerAuditRoutes(app: FastifyInstance) {
  app.get("/audit", async (request) => {
    const user = getCurrentUser(request);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        action: z.string().optional()
      })
      .parse(request.query);

    return store.auditLogs
      .filter((log) => log.organizationId === user.organizationId)
      .filter((log) => (query.action ? log.action.includes(query.action) : true))
      .slice(0, query.limit);
  });
}

