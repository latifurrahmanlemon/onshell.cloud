import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: null as any, request: vi.fn() }));
vi.mock("ssh2", () => ({ Client: class extends EventEmitter {
  constructor() { super(); mocks.client = this; }
  connect() {}
  end() {}
  shell(_options: unknown, callback: (error: null, stream: EventEmitter) => void) {
    const stream = Object.assign(new EventEmitter(), { end() {}, stderr: new EventEmitter() });
    callback(null, stream);
    (this as any).stream = stream;
  }
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

async function connected() {
  const onExit = vi.fn();
  const pending = openDirectSession({ hostId: "host", onData: vi.fn(), onExit });
  await vi.waitFor(() => expect(mocks.client).not.toBeNull());
  mocks.client.emit("ready");
  return { session: await pending, onExit, stream: mocks.client.stream };
}
it("reports silent network drops once for automatic reconnect", async () => {
  const { onExit, stream } = await connected();
  mocks.client.emit("close");
  stream.emit("close");
  expect(onExit).toHaveBeenCalledTimes(1);
  expect(onExit.mock.calls[0]?.[1]).toContain("lost");
});
it("does not reconnect after a normal shell exit", async () => {
  const { onExit, stream } = await connected();
  stream.emit("exit", 0);
  stream.emit("close", 0);
  mocks.client.emit("close");
  expect(onExit).toHaveBeenCalledExactlyOnceWith(0, undefined);
});
it("does not reconnect after the user closes a terminal", async () => {
  const { session, onExit, stream } = await connected();
  session.close();
  stream.emit("close");
  expect(onExit).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
});
