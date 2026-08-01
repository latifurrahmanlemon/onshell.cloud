import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FS_METHODS,
  MAX_DATA_FRAME_BYTES,
  agentFrameSchema,
  decodeDataFrame,
  encodeDataFrame,
  fsReaddirResultSchema,
  fsStreamParamsSchema,
  gatewayFrameSchema,
  parseFrame,
  shellTokenSchema,
  signAgentToken,
  verifyAgentToken
} from "./index.js";

const SECRET = "unit-test-secret-that-is-long-enough";

describe("data frames", () => {
  it("round-trips a channel id and payload", () => {
    const frame = encodeDataFrame(7, "hello\r\n");
    const decoded = decodeDataFrame(frame);

    expect(decoded?.channelId).toBe(7);
    expect(decoded?.payload.toString("utf8")).toBe("hello\r\n");
  });

  it("survives the top of the channel id range", () => {
    const decoded = decodeDataFrame(encodeDataFrame(0xffff_ffff, "x"));
    expect(decoded?.channelId).toBe(0xffff_ffff);
  });

  it("keeps binary payloads byte-exact", () => {
    // Terminal output is not always valid UTF-8 — a partial escape sequence or
    // a `cat` of a binary file must arrive unchanged.
    const payload = Buffer.from([0x00, 0x1b, 0x5b, 0xff, 0xfe, 0x7f]);
    expect(decodeDataFrame(encodeDataFrame(1, payload))?.payload.equals(payload)).toBe(true);
  });

  it("rejects channel zero, which no real channel uses", () => {
    const frame = Buffer.alloc(8);
    frame.writeUInt32LE(0, 0);
    expect(decodeDataFrame(frame)).toBeUndefined();
  });

  it("rejects a frame too short to hold a header", () => {
    expect(decodeDataFrame(Buffer.alloc(3))).toBeUndefined();
  });

  it("rejects an oversized frame rather than buffering it", () => {
    const frame = Buffer.alloc(4 + MAX_DATA_FRAME_BYTES + 1);
    frame.writeUInt32LE(1, 0);
    expect(decodeDataFrame(frame)).toBeUndefined();
  });
});

describe("shell tokens", () => {
  it("accepts the tokens agents advertise", () => {
    for (const token of ["powershell", "cmd", "pwsh", "bash", "zsh", "wsl:Ubuntu-22.04"]) {
      expect(shellTokenSchema.safeParse(token).success).toBe(true);
    }
  });

  it("rejects anything that could name a program instead of a shell", () => {
    // The whole security story of the protocol is that a shell is chosen from
    // the agent's own list, never described by the caller.
    for (const token of [
      "../../evil",
      "C:\\Windows\\System32\\evil.exe",
      "/bin/sh",
      "powershell -c calc",
      "powershell;calc",
      ""
    ]) {
      expect(shellTokenSchema.safeParse(token).success).toBe(false);
    }
  });
});

describe("frame parsing", () => {
  it("accepts a well-formed frame for its own direction", () => {
    const frame = parseFrame(gatewayFrameSchema, JSON.stringify({ t: "resize", ch: 1, cols: 80, rows: 24 }));
    expect(frame).toEqual({ t: "resize", ch: 1, cols: 80, rows: 24 });
  });

  it("rejects a frame meant for the other direction", () => {
    // An agent must not act on a frame only agents are supposed to send.
    const hello = JSON.stringify({
      t: "hello",
      protocolVersion: 1,
      agentVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      shells: []
    });
    expect(parseFrame(gatewayFrameSchema, hello)).toBeUndefined();
    expect(parseFrame(agentFrameSchema, hello)).toBeDefined();
  });

  it("returns undefined instead of throwing on malformed input", () => {
    expect(parseFrame(gatewayFrameSchema, "not json")).toBeUndefined();
    expect(parseFrame(gatewayFrameSchema, "{}")).toBeUndefined();
    expect(parseFrame(gatewayFrameSchema, JSON.stringify({ t: "nope" }))).toBeUndefined();
  });

  it("rejects out-of-range window sizes", () => {
    const frame = JSON.stringify({ t: "resize", ch: 1, cols: 0, rows: 24 });
    expect(parseFrame(gatewayFrameSchema, frame)).toBeUndefined();
  });
});

describe("file operations", () => {
  it("accepts a stream open naming its channel", () => {
    expect(fsStreamParamsSchema.safeParse({ path: "/tmp/x", ch: 4 }).success).toBe(true);
  });

  it("refuses a stream on the reserved channel zero", () => {
    expect(fsStreamParamsSchema.safeParse({ path: "/tmp/x", ch: 0 }).success).toBe(false);
  });

  it("parses stream frames in both directions", () => {
    // A read has the agent writing and a write has the gateway writing, so all
    // three stream frames have to validate against either union.
    for (const frame of [
      { t: "stream-end", ch: 2 },
      { t: "stream-error", ch: 2, code: "permission_denied" },
      { t: "stream-credit", ch: 2, bytes: 65536 }
    ]) {
      const raw = JSON.stringify(frame);
      expect(parseFrame(agentFrameSchema, raw)).toBeDefined();
      expect(parseFrame(gatewayFrameSchema, raw)).toBeDefined();
    }
  });

  it("refuses a credit grant of zero, which would stall the stream forever", () => {
    expect(parseFrame(gatewayFrameSchema, JSON.stringify({ t: "stream-credit", ch: 1, bytes: 0 }))).toBeUndefined();
  });

  it("keeps every fs method the file transport calls", () => {
    // The gateway's FileTransport is written against exactly these; dropping one
    // would break a file-manager action with no type error to catch it.
    for (const method of [
      "fs.resolve",
      "fs.stat",
      "fs.lstat",
      "fs.readdir",
      "fs.mkdir",
      "fs.rename",
      "fs.unlink",
      "fs.rmdir",
      "fs.openRead",
      "fs.openWrite"
    ]) {
      expect(FS_METHODS).toContain(method);
    }
  });

  it("rejects a directory listing with a malformed entry", () => {
    const bad = { entries: [{ name: "x", type: "socket", size: 1, modifiedAt: 0 }] };
    expect(fsReaddirResultSchema.safeParse(bad).success).toBe(false);
  });
});

describe("agent tokens", () => {
  it("verifies a token it signed", () => {
    const token = signAgentToken({ sub: "dev_1", organizationId: "org_1" }, SECRET);
    const payload = verifyAgentToken(token, SECRET);

    expect(payload?.sub).toBe("dev_1");
    expect(payload?.organizationId).toBe("org_1");
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAgentToken({ sub: "dev_1", organizationId: "org_1" }, "another-secret-entirely");
    expect(verifyAgentToken(token, SECRET)).toBeUndefined();
  });

  it("rejects an expired token", () => {
    const token = signAgentToken({ sub: "dev_1", organizationId: "org_1" }, SECRET, -1);
    expect(verifyAgentToken(token, SECRET)).toBeUndefined();
  });

  it("rejects a token whose signature has been tampered with", () => {
    const token = signAgentToken({ sub: "dev_1", organizationId: "org_1" }, SECRET);
    const [header, payload, signature] = token.split(".");
    const flipped = `${signature!.slice(0, -1)}${signature!.endsWith("A") ? "B" : "A"}`;
    expect(verifyAgentToken(`${header}.${payload}.${flipped}`, SECRET)).toBeUndefined();
  });

  it("refuses a token that is not an agent token", () => {
    // The load-bearing check. User access tokens are signed with the very same
    // JWT_SECRET, so without the pinned `typ` claim any logged-in user's token
    // would verify here and let them register as a device.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        sub: "user_1",
        organizationId: "org_1",
        email: "someone@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");

    expect(verifyAgentToken(`${header}.${body}.${signature}`, SECRET)).toBeUndefined();
  });

  it("refuses `alg: none`", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "dev_1", organizationId: "org_1", typ: "agent", exp: Math.floor(Date.now() / 1000) + 60 })
    ).toString("base64url");

    expect(verifyAgentToken(`${header}.${body}.`, SECRET)).toBeUndefined();
    expect(verifyAgentToken(`${header}.${body}`, SECRET)).toBeUndefined();
  });

  it("rejects a token with extra segments", () => {
    const token = signAgentToken({ sub: "dev_1", organizationId: "org_1" }, SECRET);
    expect(verifyAgentToken(`${token}.extra`, SECRET)).toBeUndefined();
  });
});
