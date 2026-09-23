import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { offlineEntityId } from "../../lib/offline-id.js";
const mock = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  create: vi.fn(),
  actor: { id: "user", organizationId: "org", role: "owner" },
}));
vi.mock("../../lib/current-user.js", () => ({
  getAuthenticatedUser: async () => mock.actor,
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    taskItem: {
      findFirst: async ({ where }: any) => mock.rows.get(where.id),
      create: mock.create,
    },
  },
}));
import { registerTaskRoutes } from "./tasks.js";
it("makes queued creates idempotent and scopes IDs to the authenticated account", async () => {
  const app = Fastify();
  mock.rows.clear();
  mock.create.mockImplementation(async ({ data }) => {
    const row = {
      ...data,
      completed: false,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mock.rows.set(row.id, row);
    return row;
  });
  try {
    await registerTaskRoutes(app);
    const nonce = "516568d3-aa78-4d32-8265-45b17f45cc9a";
    const options = {
      method: "POST" as const,
      url: "/tasks",
      headers: { "x-onshell-offline-id": nonce },
      payload: { text: "Offline task", organizationId: "other" },
    };
    const first = await app.inject(options);
    const retry = await app.inject(options);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(first.json().id).toBe(retry.json().id);
    expect(first.json().id).toBe(
      offlineEntityId(
        { headers: { "x-onshell-offline-id": nonce } },
        mock.actor,
      ),
    );
    expect(first.json().organizationId).toBe("org");
    expect(mock.create).toHaveBeenCalledTimes(1);
    mock.actor = { ...mock.actor, id: "second-user" };
    expect((await app.inject(options)).json().id).not.toBe(first.json().id);
    expect(
      (
        await app.inject({
          ...options,
          headers: { "x-onshell-offline-id": "invalid" },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
}, 15000);
