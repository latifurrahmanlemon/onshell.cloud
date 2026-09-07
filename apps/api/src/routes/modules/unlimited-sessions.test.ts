import Fastify from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: { id: "user", organizationId: "org", role: "OWNER" },
  subscription: vi.fn().mockResolvedValue({ plan: { maxConcurrentSessions: 1 } }),
  count: vi.fn().mockResolvedValue(100),
  host: vi.fn().mockResolvedValue({ id: "host", address: "host.test", port: 22, credentials: [{ id: "credential", kind: "PASSWORD" }] }),
  create: vi.fn().mockResolvedValue({ id: "session" })
}));
vi.mock("../../lib/prisma.js", () => ({ prisma: {
  host: { findFirst: mocks.host },
  credential: { update: vi.fn().mockResolvedValue({}) },
  session: { create: mocks.create, count: mocks.count },
  subscription: { findFirst: mocks.subscription }
} }));
vi.mock("../../lib/current-user.js", () => ({ getAuthenticatedUser: async () => mocks.actor }));
vi.mock("../../lib/host-access.js", () => ({ accessibleHostFilter: async () => ({}) }));
vi.mock("../../lib/encryption.js", () => ({ decryptSecret: () => "test-password" }));
vi.mock("../../lib/gateway.js", () => ({ gatewayHeaders: () => ({}), reconcileSessions: async () => {} }));
vi.mock("../../lib/provisioning.js", () => ({ canUseLocalShell: () => true }));
vi.mock("../../lib/prisma-mappers.js", () => ({ recordAudit: async () => {}, sessionProtocolToPrisma: { ssh: "SSH", sftp: "SFTP", rdp: "RDP" }, sessionProtocolFromPrisma: {}, toRemoteSession: (session: unknown) => session }));
import { registerSessionRoutes } from "./sessions.js";

afterEach(() => vi.unstubAllGlobals());
it.each(["ssh", "sftp", "rdp"])("opens web %s sessions even when a legacy plan limit is exceeded", async (protocol) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ session: { id: "gateway-session" }, websocketUrl: "ws://gateway/session" }) }));
  const app = Fastify();
  try {
    await registerSessionRoutes(app, { gatewayBaseUrl: "http://gateway", masterEncryptionKey: "test" } as RuntimeConfig);
    const response = await app.inject({ method: "POST", url: "/sessions", payload: { hostId: "host", protocol } });
    expect(response.statusCode).toBe(201);
    expect(mocks.subscription).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
