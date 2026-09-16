import Fastify from "fastify";
import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ prisma: { snippet: db } }));
vi.mock("../../lib/current-user.js", () => ({ getAuthenticatedUser: async () => ({ id: "user", organizationId: "org", role: "OWNER" }) }));
vi.mock("../../lib/host-access.js", () => ({ accessibleHostFilter: async () => ({}) }));
vi.mock("../../lib/prisma-mappers.js", () => ({ recordAudit: async () => {}, toSnippet: (value: unknown) => value }));
import { registerSnippetRoutes } from "./snippets.js";

beforeEach(() => {
  vi.clearAllMocks();
  db.findMany.mockResolvedValue([]);
  db.findFirst.mockResolvedValue({ id: "snippet", ownerId: "user" });
  db.update.mockImplementation(async ({ data }) => ({ id: "snippet", ...data }));
});

async function request(method: "GET" | "PATCH", payload?: object) {
  const app = Fastify();
  try {
    await registerSnippetRoutes(app);
    return await app.inject({ method, url: method === "GET" ? "/snippets" : "/snippets/snippet", payload });
  } finally { await app.close(); }
}

it("returns server-sorted snippets with deterministic ties", async () => {
  expect((await request("GET")).statusCode).toBe(200);
  expect(db.findMany.mock.calls[0]?.[0].orderBy).toEqual([{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "asc" }]);
}, 15000);
it("persists and returns an edited order number", async () => {
  const result = await request("PATCH", { sortOrder: 12 });
  expect(result.statusCode).toBe(200);
  expect(result.json().sortOrder).toBe(12);
  expect(db.update.mock.calls[0]?.[0].data).toEqual({ sortOrder: 12 });
});
it("does not reset order when an older client edits only the name", async () => {
  expect((await request("PATCH", { name: "Updated" })).statusCode).toBe(200);
  expect(db.update.mock.calls[0]?.[0].data).not.toHaveProperty("sortOrder");
});
it.each([-1, 1.5, 1000000, "2"])("rejects invalid order %s", async (sortOrder) => {
  expect((await request("PATCH", { sortOrder })).statusCode).toBe(400);
  expect(db.update).not.toHaveBeenCalled();
});
