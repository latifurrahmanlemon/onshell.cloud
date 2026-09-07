import { generateKeyPairSync } from "node:crypto";
import { Server } from "ssh2";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./session.js", () => ({ requireApi: () => ({ transport: api }) }));
vi.mock("./device.js", () => ({ deviceSecret: async () => "test-device" }));
import { openDirectSession } from "./ssh.js";

it("opens a real direct SSH shell and sends input without a gateway", async () => {
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
  let session: Awaited<ReturnType<typeof openDirectSession>> | undefined;
  try {
    const output = vi.fn();
    session = await openDirectSession({ hostId: "test-host", onData: (data) => output(data.toString()), onExit: vi.fn() });
    session.write("hello");
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith("echo:hello"));
    expect(session.title).toBe("test-user@127.0.0.1");
  } finally {
    session?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
