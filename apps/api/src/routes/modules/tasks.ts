import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { prisma } from "../../lib/prisma.js";
import { handleRouteError } from "../../lib/reply.js";

const paramsSchema = z.object({ taskId: z.string().min(1) });
const createSchema = z.object({ text: z.string().trim().min(1).max(2000) });
const patchSchema = z.object({ text: z.string().trim().min(1).max(2000).optional(), completed: z.boolean().optional() })
  .refine((body) => body.text !== undefined || body.completed !== undefined);

function payload(task: { id: string; organizationId: string; ownerId: string; text: string; completed: boolean; completedAt: Date | null; createdAt: Date; updatedAt: Date }) {
  return { ...task, completedAt: task.completedAt?.toISOString(), createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() };
}

export async function registerTaskRoutes(app: FastifyInstance) {
  app.get("/tasks", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const tasks = await prisma.taskItem.findMany({
        where: { organizationId: actor.organizationId, ownerId: actor.id },
        orderBy: [{ completed: "asc" }, { createdAt: "desc" }]
      });
      return { tasks: tasks.map(payload) };
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.post("/tasks", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const body = createSchema.parse(request.body);
      const task = await prisma.taskItem.create({ data: { organizationId: actor.organizationId, ownerId: actor.id, text: body.text } });
      return reply.code(201).send(payload(task));
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.patch("/tasks/:taskId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const { taskId } = paramsSchema.parse(request.params);
      const body = patchSchema.parse(request.body);
      const existing = await prisma.taskItem.findFirst({ where: { id: taskId, organizationId: actor.organizationId, ownerId: actor.id } });
      if (!existing) return reply.code(404).send({ error: "task_not_found" });
      const task = await prisma.taskItem.update({ where: { id: existing.id }, data: { ...(body.text !== undefined && { text: body.text }), ...(body.completed !== undefined && { completed: body.completed, completedAt: body.completed ? new Date() : null }) } });
      return payload(task);
    } catch (error) { return handleRouteError(reply, error); }
  });

  app.delete("/tasks/:taskId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      const { taskId } = paramsSchema.parse(request.params);
      const deleted = await prisma.taskItem.deleteMany({ where: { id: taskId, organizationId: actor.organizationId, ownerId: actor.id } });
      if (deleted.count === 0) return reply.code(404).send({ error: "task_not_found" });
      return { ok: true };
    } catch (error) { return handleRouteError(reply, error); }
  });
}
