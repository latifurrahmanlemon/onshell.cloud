import { describe, expect, it, vi } from "vitest";
import { copyBridgeWithActivity } from "./activity-bridge.js";

describe("desktop activity bridge", () => {
  it("wraps a deeply frozen contextBridge object without violating proxy invariants", async () => {
    const source = Object.freeze({
      getState: vi.fn(async () => ({ ready: true })),
      server: Object.freeze({ use: vi.fn(async () => ({ ok: true })) })
    });
    const starts: string[] = [];
    const bridge = copyBridgeWithActivity(
      source,
      (path) => path !== "getState",
      async (promise) => {
        starts.push("start");
        return promise.finally(() => starts.push("end"));
      }
    );

    await expect(bridge.getState()).resolves.toEqual({ ready: true });
    await expect(bridge.server.use()).resolves.toEqual({ ok: true });
    expect(starts).toEqual(["start", "end"]);
  });
});
