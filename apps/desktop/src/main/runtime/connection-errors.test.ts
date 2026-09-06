import { describe, expect, it } from "vitest";
import { connectionFailure } from "./connection-errors.js";

describe("connection failure explanations", () => {
  it.each([
    ["ENOTFOUND", "resolve"],
    ["EAI_AGAIN", "DNS"],
    ["ECONNREFUSED", "refused"],
    ["ENETUNREACH", "VPN"],
    ["EHOSTUNREACH", "network route"],
    ["ETIMEDOUT", "in time"],
    ["ECONNRESET", "closed"],
  ])("explains %s without exposing raw diagnostics", (code, reason) => {
    const message = connectionFailure({ code, message: "secret-key-material" }, "host:22");
    expect(message).toContain(reason);
    expect(message).toContain("host:22");
    expect(message).not.toContain("secret-key-material");
  });
  it("recognizes nested transport causes", () => {
    expect(connectionFailure({ cause: { code: "ECONNREFUSED" } }, "gateway")).toContain("refused");
  });
  it("explains authentication and handshake failures", () => {
    expect(connectionFailure({ level: "client-authentication" }, "host")).toContain("credentials");
    expect(connectionFailure({ level: "handshake" }, "host")).toContain("algorithms");
  });
  it("handles unknown failures without leaking their contents", () => {
    expect(connectionFailure(new Error("secret"), "host")).not.toContain("secret");
    expect(connectionFailure(null, "host")).toContain("host");
  });
});
