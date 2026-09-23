import { app, safeStorage } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiClient } from "@onshell/api-client";
import type { User } from "@onshell/shared";
import { deviceSecret } from "./device.js";
import {
  LocalWorkspace,
  emptyData,
  type LocalData,
  type OfflineGrant,
  type SyncStatus,
} from "./local-workspace.js";

let workspace: LocalWorkspace | undefined;
let active = false;
let ready: Promise<void> = Promise.resolve();
let writes: Promise<unknown> = Promise.resolve();
let filename = "";
let client: ApiClient;
let generation = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function encryptionAvailable() {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      safeStorage.getSelectedStorageBackend() !== "basic_text")
  );
}
function install(
  data: LocalData,
  scope: number,
  target: string,
  api: ApiClient,
) {
  workspace?.stop();
  workspace = new LocalWorkspace(
    data,
    async (next) => {
      if (!encryptionAvailable())
        throw new Error(
          "Unlock your operating system keychain to save offline data securely.",
        );
      const encrypted = safeStorage.encryptString(JSON.stringify(next));
      const job = writes.then(async () => {
        if (scope !== generation)
          throw new Error("Workspace changed while saving.");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(`${target}.tmp`, encrypted, { mode: 0o600 });
        await rename(`${target}.tmp`, target);
      });
      writes = job.catch(() => {});
      await job;
    },
    api,
    async () => {
      const secret = await deviceSecret();
      if (!secret)
        throw new Error(
          "Enroll this computer online once to prepare offline SSH.",
        );
      return api.transport.request<{
        grants: OfflineGrant[];
        allowed: boolean;
      }>("/desktop/offline-bundle", {
        headers: { "x-onshell-device-secret": secret },
      });
    },
  );
}
export function configureLocal(apiBaseUrl: string, api: ApiClient) {
  workspace?.stop();
  workspace = undefined;
  active = false;
  client = api;
  const scope = ++generation;
  const target = (filename = path.join(
    app.getPath("userData"),
    `offline-${createHash("sha256").update(apiBaseUrl.replace(/\/+$/, "")).digest("hex").slice(0, 24)}.bin`,
  ));
  ready = (async () => {
    await writes;
    if (!encryptionAvailable()) return;
    try {
      const data = JSON.parse(
        safeStorage.decryptString(await readFile(target)),
      ) as LocalData;
      if (scope === generation && data.user && Array.isArray(data.changes))
        install(data, scope, target, api);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(
          "Offline workspace could not be unlocked; keeping the encrypted file intact.",
        );
    }
  })();
  clearInterval(timer);
  timer = setInterval(() => {
    if (active) void workspace?.sync();
  }, 60_000);
  timer.unref();
}
export async function localUser() {
  await ready;
  active = Boolean(workspace);
  return workspace?.data.user;
}
export async function setLocalUser(user: User) {
  await ready;
  if (
    workspace?.data.user.id === user.id &&
    workspace.data.user.organizationId === user.organizationId
  ) {
    active = true;
    return;
  }
  workspace?.stop();
  ++generation;
  await writes;
  install(emptyData(user), generation, filename, client);
  // Persist identity before the first network sync so the app can restart offline.
  if (!encryptionAvailable())
    throw new Error(
      "Enable the operating system keychain before using the desktop app offline.",
    );
  await workspace!.save();
  active = true;
}
export async function clearLocal() {
  await ready;
  workspace?.stop();
  workspace = undefined;
  active = false;
  ++generation;
  await writes;
  if (filename) await rm(filename, { force: true });
}
export function requireLocalApi(): ApiClient {
  if (!workspace || !active)
    throw new Error("Sign in to load your saved workspace.");
  return workspace.proxy();
}
export function localSync(action?: "retry" | "discard"): SyncStatus {
  if (action !== undefined && action !== "retry" && action !== "discard")
    throw new Error("Unknown sync action.");
  if (!active)
    return { revision: "0", pending: 0, syncing: false, offlineHosts: 0 };
  if (action === "discard") void workspace?.discardPending().catch(() => {});
  else if (action === "retry") void workspace?.sync();
  return (
    workspace?.status() ?? {
      revision: "0",
      pending: 0,
      syncing: false,
      offlineHosts: 0,
    }
  );
}
export function localGrant(hostId: string, credentialId?: string) {
  return active ? workspace?.grant(hostId, credentialId) : undefined;
}

export async function recordLocalSession(
  id: string,
  details: Record<string, unknown>,
) {
  if (workspace && active)
    await workspace.mutate("recordSession", [id, details]);
}
