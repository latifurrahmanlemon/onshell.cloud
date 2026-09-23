import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@onshell/api-client";
import type { User } from "@onshell/shared";
import {
  collections,
  emptyData,
  LocalWorkspace,
  localEntityId,
  type LocalData,
} from "./local-workspace.js";
const user = { id: "user", organizationId: "org", role: "owner" } as User;
function setup() {
  const data = emptyData(user);
  data.identity = { user };
  for (const key of collections) data.rows[key] = [];
  data.rows.hosts = [
    { id: "host", name: "Server", address: "127.0.0.1", port: 22 },
  ];
  data.rows.credentials = [
    { id: "cred", kind: "password", attachedHostIds: ["host"] },
  ];
  data.grants = [
    {
      hostId: "host",
      credentialId: "cred",
      credential: { kind: "password", material: "private-password" },
    },
  ];
  data.directAllowed = true;
  let saved: LocalData = structuredClone(data);
  const remote: any = {
    me: vi.fn(async () => ({ user })),
    transport: { request: vi.fn() },
  };
  for (const key of collections)
    remote[key] = vi.fn(async () => structuredClone(data.rows[key]));
  const bundle = vi.fn(async () => ({
    version: 1,
    grants: structuredClone(data.grants),
    allowed: true,
  }));
  const save = vi.fn(async (value: LocalData) => {
    saved = structuredClone(value);
  });
  const engine = new LocalWorkspace(data, save, remote as ApiClient, bundle);
  return { data, engine, remote, bundle, save, saved: () => saved };
}
describe("local-first workspace", () => {
  it("reads cached lists and direct credentials without contacting the server", async () => {
    const { engine, remote } = setup();
    expect((await engine.read("hosts"))[0].name).toBe("Server");
    expect(engine.grant("host")?.credential.material).toBe("private-password");
    expect(remote.me).not.toHaveBeenCalled();
    expect(await engine.identity()).toEqual({ user });
  });
  it("keeps cached data and queued edits through failure and process restart", async () => {
    const { engine, remote, saved, save, bundle } = setup();
    remote.me.mockRejectedValue(new Error("offline"));
    const task = await engine.mutate("createTask", ["Saved offline"]);
    await engine.sync();
    expect(engine.status().pending).toBe(1);
    expect(engine.status().error).toContain("offline");
    const restarted = new LocalWorkspace(saved(), save, remote, bundle);
    expect(await restarted.read("tasks")).toEqual([
      expect.objectContaining({ id: task.id, text: "Saved offline" }),
    ]);
    expect(restarted.grant("host")).toBeDefined();
  });
  it("replays lost create acknowledgements with the same stable ID", async () => {
    const { engine, remote, saved, save, bundle } = setup();
    remote.me.mockRejectedValueOnce(new Error("offline"));
    const task = await engine.mutate("createTask", ["One task"]);
    await engine.sync();
    const ids = new Set<string>();
    remote.transport.request.mockImplementation(
      async (_path: string, options: any) => {
        const id = localEntityId(user, options.headers["x-onshell-offline-id"]);
        ids.add(id);
        if (remote.transport.request.mock.calls.length === 1)
          throw new Error("response lost");
        return { id, text: "One task" };
      },
    );
    await engine.sync();
    expect(engine.status().pending).toBe(1);
    const restarted = new LocalWorkspace(saved(), save, remote, bundle);
    await restarted.sync();
    expect(restarted.status().pending).toBe(0);
    expect([...ids]).toEqual([task.id]);
  });
  it("retains local edits made while a remote snapshot is being fetched", async () => {
    const { engine, remote } = setup();
    let release!: (rows: any[]) => void;
    const delayed = new Promise<any[]>((resolve) => {
      release = resolve;
    });
    remote.hosts.mockReturnValueOnce(delayed);
    const syncing = engine.sync();
    await vi.waitFor(() => expect(remote.hosts).toHaveBeenCalled());
    await engine.mutate("updateHost", ["host", { name: "Local name" }]);
    remote.updateHost = vi.fn().mockRejectedValue(new Error("offline"));
    release([{ id: "host", name: "Old remote name" }]);
    await syncing;
    await engine.sync();
    expect((await engine.read("hosts"))[0].name).toBe("Local name");
    expect(engine.status().pending).toBe(1);
  });
  it("does not erase cached lists when one snapshot request fails", async () => {
    const { engine, remote } = setup();
    remote.hosts.mockResolvedValue([]);
    remote.tasks.mockRejectedValue(new Error("unavailable"));
    await engine.sync();
    expect((await engine.read("hosts"))[0].name).toBe("Server");
  });
  it("removes saved SSH access immediately on device revocation", async () => {
    const { engine, bundle, remote } = setup();
    bundle.mockRejectedValue(
      Object.assign(new Error("revoked"), { status: 403 }),
    );
    remote.hosts.mockRejectedValue(new Error("snapshot failure"));
    await engine.sync();
    expect(engine.grant("host")).toBeUndefined();
  });
  it("does not send local writes to another account or organization", async () => {
    const { engine, remote } = setup();
    remote.me.mockResolvedValue({
      user: { ...user, organizationId: "another" },
    });
    await engine.mutate("createTask", ["Private task"]);
    await engine.sync();
    expect(remote.transport.request).not.toHaveBeenCalled();
    expect(engine.status().pending).toBe(1);
    expect(engine.grant("host")).toBeUndefined();
  });
  it("refuses replay to older servers before creating any rows", async () => {
    const { engine, remote, bundle } = setup();
    bundle.mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    await engine.mutate("createTask", ["Wait for upgrade"]);
    await engine.sync();
    expect(remote.transport.request).not.toHaveBeenCalled();
    expect(engine.status().pending).toBe(1);
  });
  it("keeps secrets out of credential lists and preserves unattached new credentials", async () => {
    const { engine, remote } = setup();
    remote.me.mockRejectedValue(new Error("offline"));
    const credential = await engine.mutate("createCredential", [
      {
        name: "New key",
        kind: "password",
        secret: "local-secret",
        attachedHostIds: [],
      },
    ]);
    expect(credential.secret).toBeUndefined();
    await engine.mutate("updateCredential", [
      credential.id,
      { attachedHostIds: ["host"] },
    ]);
    expect(engine.grant("host", credential.id)?.credential.material).toBe(
      "local-secret",
    );
    expect(JSON.stringify(await engine.read("credentials"))).not.toContain(
      "local-secret",
    );
  });
  it("keeps queue and local state unchanged when disk persistence fails", async () => {
    const { engine, save } = setup();
    save.mockRejectedValue(new Error("disk full"));
    await expect(engine.mutate("createTask", ["Not saved"])).rejects.toThrow(
      "disk full",
    );
    expect(await engine.read("tasks")).toEqual([]);
    expect(engine.status().pending).toBe(0);
  });
  it("honors cached roles for offline edits", async () => {
    const { engine } = setup();
    engine.data.user = { ...user, role: "developer" };
    await expect(
      engine.mutate("createCredential", [{ secret: "x" }]),
    ).rejects.toThrow("role");
    expect(engine.status().pending).toBe(0);
  });
  it("removes locally deleted hosts from direct connections", async () => {
    const { engine, remote } = setup();
    remote.me.mockRejectedValue(new Error("offline"));
    await engine.mutate("deleteHost", ["host"]);
    expect(engine.grant("host")).toBeUndefined();
  });
  it("preserves offline session history and never exposes credential material in it", async () => {
    const { engine, remote } = setup();
    remote.me.mockRejectedValue(new Error("offline"));
    await engine.mutate("recordSession", [
      "local-session",
      { hostId: "host", protocol: "ssh", status: "pending", startedAt: "now" },
    ]);
    await engine.mutate("recordSession", [
      "local-session",
      { status: "closed", endedAt: "later" },
    ]);
    expect(await engine.read("sessions")).toEqual([
      expect.objectContaining({
        hostId: "host",
        status: "closed",
        endedAt: "later",
      }),
    ]);
  });
});
