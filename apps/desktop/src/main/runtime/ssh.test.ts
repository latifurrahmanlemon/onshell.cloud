import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: null as any, request: vi.fn() }));
vi.mock("ssh2", () => ({ Client: class extends EventEmitter {
  constructor() { super(); mocks.client = this; }
  connect() {}
  end() {}
} }));
vi.mock("./session.js", () => ({ requireApi: () => ({ transport: { request: mocks.request } }) }));
vi.mock("./device.js", () => ({ deviceSecret: async () => "device-secret" }));
import { openDirectSession } from "./ssh.js";

beforeEach(() => {
  mocks.client = null;
  mocks.request.mockReset().mockResolvedValue({
    sessionId: "session", host: { address: "host", port: 22, username: "user" },
    credential: { kind: "password", material: "secret" }
  });
});

it("rejects when the host closes before opening a shell instead of leaving the request pending", async () => {
  const pending = openDirectSession({ hostId: "host", onData: vi.fn(), onExit: vi.fn() });
  const rejection = expect(pending).rejects.toThrow("before a shell could be opened");
  await vi.waitFor(() => expect(mocks.client).not.toBeNull());
  mocks.client.emit("close");
  await rejection;
});

it("returns an actionable refused-connection reason", async () => {
  const pending = openDirectSession({ hostId: "host", onData: vi.fn(), onExit: vi.fn() });
  const rejection = expect(pending).rejects.toThrow("host:22 refused the connection");
  await vi.waitFor(() => expect(mocks.client).not.toBeNull());
  mocks.client.emit("error", Object.assign(new Error("raw secret"), { code: "ECONNREFUSED" }));
  await rejection;
});
