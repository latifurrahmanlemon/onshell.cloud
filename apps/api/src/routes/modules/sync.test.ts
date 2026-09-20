import Fastify from "fastify";
import { expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ update: vi.fn(), findUnique: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ prisma: { organization: db } }));
vi.mock("../../lib/current-user.js", () => ({ getAuthenticatedUser: async (request: { headers: Record<string, string> }) => request.headers["x-test-org"] ? { organizationId: request.headers["x-test-org"] } : null }));
import { registerSyncRoutes } from "./sync.js";

it("publishes successful writes, isolates organizations, and rejects anonymous readers", async () => {
  db.update.mockClear(); db.findUnique.mockResolvedValue({ syncRevision: 7 });
  const app = Fastify();
  try {
    await registerSyncRoutes(app);
    app.post("/tasks", async () => ({ ok: true }));
    app.patch("/snippets/denied", async (_request, reply) => reply.code(403).send({ error: "forbidden" }));
    await app.inject({ method: "POST", url: "/tasks", headers: { "x-test-org": "org-a" } });
    expect(db.update).toHaveBeenCalledExactlyOnceWith({ where: { id: "org-a" }, data: { syncRevision: { increment: 1 } } });
    await app.inject({ method: "PATCH", url: "/snippets/denied", headers: { "x-test-org": "org-a" } });
    expect(db.update).toHaveBeenCalledTimes(1);
    const result = await app.inject({ url: "/sync", headers: { "x-test-org": "org-b" } });
    expect(result.json()).toEqual({ revision: "org-b:7" });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ url: "/sync" })).statusCode).toBe(401);
  } finally { await app.close(); }
}, 15000);
