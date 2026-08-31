import { describe, expect, it } from "vitest";
import { safeWorkspaceTargets } from "./workspace.js";

describe("safeWorkspaceTargets", () => {
  it("keeps supported target fields and rejects unknown shapes", () => {
    expect(
      safeWorkspaceTargets([
        { kind: "local", shellId: "pwsh", cwd: "C:\\work", secret: "no" },
        {
          kind: "direct",
          hostId: "host-1",
          credentialId: "cred-1",
          password: "no"
        },
        { kind: "relay", hostId: "host-2", shell: "bash" },
        { kind: "other", hostId: "host-3" },
        null
      ])
    ).toEqual([
      { kind: "local", shellId: "pwsh", cwd: "C:\\work" },
      { kind: "direct", hostId: "host-1", credentialId: "cred-1" },
      { kind: "relay", hostId: "host-2", shell: "bash" }
    ]);
  });

  it("bounds the number and length of persisted values", () => {
    const result = safeWorkspaceTargets(
      Array.from({ length: 40 }, () => ({
        kind: "direct",
        hostId: "x".repeat(500)
      }))
    );
    expect(result).toHaveLength(24);
    expect(result[0]).toEqual({ kind: "direct", hostId: "x".repeat(200) });
  });

  it("returns an empty layout for non-array IPC input", () => {
    expect(safeWorkspaceTargets({ kind: "local" })).toEqual([]);
  });
});
