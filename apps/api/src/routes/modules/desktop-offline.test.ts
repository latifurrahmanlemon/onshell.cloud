import Fastify from "fastify";
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@onshell/config";
const mock = vi.hoisted(() => ({
  actor: { id: "user", organizationId: "org", role: "owner" } as any,
  device: vi.fn(),
  policy: vi.fn(),
  hosts: vi.fn(),
  decrypt: vi.fn(),
  access: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../lib/current-user.js", () => ({
  getAuthenticatedUser: async () => mock.actor,
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    desktopDevice: { findFirst: mock.device, update: mock.update },
    organization: { findUnique: mock.policy },
    host: { findMany: mock.hosts },
  },
}));
vi.mock("../../lib/encryption.js", () => ({ decryptSecret: mock.decrypt }));
vi.mock("../../lib/host-access.js", () => ({
  accessibleHostFilter: mock.access,
}));
vi.mock("../../lib/prisma-mappers.js", () => ({
  recordAudit: vi.fn(),
  membershipOrder: [],
  toPublicUser: vi.fn(),
}));
vi.mock("./auth.js", () => ({
  issueTokens: vi.fn(),
  recordAuthEvent: vi.fn(),
}));
import { registerDesktopRoutes } from "./desktop.js";
beforeEach(() => {
  vi.clearAllMocks();
  mock.actor = { id: "user", organizationId: "org", role: "owner" };
  mock.device.mockResolvedValue({ id: "device", revokedAt: null });
  mock.policy.mockResolvedValue({ allowDirectConnect: true });
  mock.access.mockResolvedValue({
    organizationId: "org",
    accessGrants: { some: { userId: "user" } },
  });
  mock.hosts.mockResolvedValue([
    {
      id: "host",
      credentials: [
        {
          id: "credential",
          kind: "SSH_KEY",
          encryptedPayload: "cipher",
          nonce: "nonce",
          authTag: "tag",
          sshKey: null,
        },
      ],
    },
  ]);
  mock.decrypt.mockReturnValue("private-key-material");
  mock.update.mockResolvedValue({});
}, 15000);
async function request(
  headers: Record<string, string> = {
    "x-onshell-device-secret": "device-secret",
  },
) {
  const app = Fastify();
  try {
    await registerDesktopRoutes(app, {
      masterEncryptionKey: "test",
    } as RuntimeConfig);
    return await app.inject({
      method: "GET",
      url: "/desktop/offline-bundle",
      headers,
    });
  } finally {
    await app.close();
  }
}
it("never decrypts before authentication and device checks", async () => {
  mock.actor = null;
  expect((await request()).statusCode).toBe(401);
  mock.actor = { id: "user", organizationId: "org", role: "owner" };
  expect((await request({})).statusCode).toBe(401);
  mock.device.mockResolvedValue({ id: "device", revokedAt: new Date() });
  expect((await request()).statusCode).toBe(403);
  expect(mock.decrypt).not.toHaveBeenCalled();
}, 15000);
it("returns an empty grant set when policy or role revokes direct access", async () => {
  mock.policy.mockResolvedValue({ allowDirectConnect: false });
  expect((await request()).json()).toEqual({
    version: 1,
    allowed: false,
    grants: [],
  });
  mock.policy.mockResolvedValue({ allowDirectConnect: true });
  mock.actor.role = "auditor";
  expect((await request()).json().allowed).toBe(false);
  expect(mock.decrypt).not.toHaveBeenCalled();
}, 15000);
it("exports only credentials attached to accessible direct SSH hosts and prevents HTTP caching", async () => {
  const response = await request();
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(mock.access).toHaveBeenCalledWith("user", "owner", "org");
  expect(mock.hosts.mock.calls[0][0].where).toEqual({
    organizationId: "org",
    accessGrants: { some: { userId: "user" } },
    isLocal: false,
    isAgent: false,
    type: "SSH",
  });
  expect(response.json().grants).toEqual([
    {
      hostId: "host",
      credentialId: "credential",
      credential: { kind: "privateKey", material: "private-key-material" },
    },
  ]);
}, 15000);
