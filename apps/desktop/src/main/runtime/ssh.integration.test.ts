import { generateKeyPairSync } from "node:crypto";
import { Server } from "ssh2";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ request: vi.fn(), saved: undefined as any }));
vi.mock("./session.js", () => ({ requireApi: () => ({ transport: api }) }));
vi.mock("./device.js", () => ({ deviceSecret: async () => "test-device" }));
vi.mock("./local-data.js", () => ({ localGrant: () => api.saved, recordLocalSession: vi.fn(async () => {}) }));
import { openDirectSession } from "./ssh.js";

it.each([false, true])("opens a real direct SSH shell (offline cached grant: %s)", async (offline) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const server = new Server({ hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "test-user" && context.password === "test-password") context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.on("data", (data: Buffer) => stream.write(`echo:${data.toString()}`));
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("No test SSH listener");
  api.request.mockResolvedValue({ sessionId: "test", host: { address: "127.0.0.1", port: address.port, username: "test-user" }, credential: { kind: "password", material: "test-password" } });
  api.saved = offline ? { host: { address: "127.0.0.1", port: address.port, username: "test-user" }, credential: { kind: "password", material: "test-password" } } : undefined;
  if (offline) api.request.mockReset().mockRejectedValue(new Error("API server is down"));
  const exited = vi.fn();
  let session: Awaited<ReturnType<typeof openDirectSession>> | undefined;
  try {
    const output = vi.fn();
    session = await openDirectSession({ hostId: "test-host", onData: (data) => output(data.toString()), onExit: exited });
    session.write("hello");
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith("echo:hello"));
    if (offline) expect(api.request).not.toHaveBeenCalled();
    expect(session.title).toBe("test-user@127.0.0.1");
  } finally {
    session?.close();
    if (session) await vi.waitFor(() => expect(exited).toHaveBeenCalled());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
