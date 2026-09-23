import { createHash, randomUUID } from "node:crypto";
import type { ApiClient } from "@onshell/api-client";
import {
  canManageHosts,
  canOpenSession,
  canManageUsers,
  type User,
} from "@onshell/shared";

export const collections = [
  "hosts",
  "credentials",
  "snippets",
  "tasks",
  "notifications",
  "sessions",
  "audit",
  "workspaces",
] as const;
type Collection = (typeof collections)[number];
type Row = Record<string, any>;
export interface OfflineGrant {
  hostId: string;
  credentialId: string;
  credential: {
    kind: "password" | "privateKey";
    material: string;
    passphraseHint?: string;
  };
}
export interface Change {
  nonce: string;
  method: string;
  args: any[];
  collection: Collection;
  id: string;
  at: string;
}
export interface LocalData {
  user: User;
  identity?: any;
  rows: Partial<Record<Collection, Row[]>>;
  changes: Change[];
  grants: OfflineGrant[];
  localSecrets?: Record<string, OfflineGrant["credential"]>;
  directAllowed: boolean;
  lastSync?: string;
}
export interface SyncStatus {
  revision: string;
  pending: number;
  syncing: boolean;
  lastSync?: string;
  error?: string;
  offlineHosts: number;
}
const mutations: Record<string, Collection> = {
  createHost: "hosts",
  updateHost: "hosts",
  deleteHost: "hosts",
  setHostFavorite: "hosts",
  createCredential: "credentials",
  updateCredential: "credentials",
  rotateCredential: "credentials",
  deleteCredential: "credentials",
  createSnippet: "snippets",
  updateSnippet: "snippets",
  deleteSnippet: "snippets",
  createTask: "tasks",
  updateTask: "tasks",
  deleteTask: "tasks",
  recordSession: "sessions",
  createWorkspace: "workspaces",
  deleteWorkspace: "workspaces",
  markNotificationRead: "notifications",
};
const paths: Partial<Record<Collection, string>> = {
  hosts: "/hosts",
  credentials: "/credentials",
  snippets: "/snippets",
  tasks: "/tasks",
  workspaces: "/host-workspaces",
};
export function localEntityId(user: User, nonce: string) {
  return `offline-${createHash("sha256")
    .update(JSON.stringify([user.organizationId, user.id, nonce]))
    .digest("hex")
    .slice(0, 40)}`;
}
export function emptyData(user: User): LocalData {
  return { user, rows: {}, changes: [], grants: [], directAllowed: false };
}

/** Pure data engine. Persistence is supplied by the main process; no secret crosses IPC. */
export class LocalWorkspace {
  private serial: Promise<unknown> = Promise.resolve();
  private running?: Promise<void>;
  private revision = 0;
  private error?: string;
  private stopped = false;
  private rerun = false;
  private attempted = false;
  constructor(
    public data: LocalData,
    private persist: (data: LocalData) => Promise<void>,
    private client: ApiClient,
    private bundle: () => Promise<{ grants: OfflineGrant[]; allowed: boolean }>,
  ) {}
  stop() {
    this.stopped = true;
  }
  async save() {
    await this.exclusive(() => this.commit(this.data));
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const job = this.serial.then(action, action);
    this.serial = job.catch(() => {});
    return job;
  }
  private async commit(next: LocalData) {
    if (this.stopped)
      throw new Error("The signed-in workspace changed. Please try again.");
    await this.persist(next);
    this.data = next;
    this.revision++;
  }
  status(): SyncStatus {
    return {
      revision: String(this.revision),
      pending: this.data.changes.length,
      syncing: !!this.running,
      lastSync: this.data.lastSync,
      error: this.error,
      offlineHosts: new Set(this.view().grants.map((g) => g.hostId)).size,
    };
  }
  private apply(data: LocalData, change: Change): Row | undefined {
    const { method, args, collection, id, at } = change;
    const rows = (data.rows[collection] ??= []);
    let item = rows.find((row) => row.id === id);
    if (method === "recordSession") {
      item = {
        ...item,
        ...args[1],
        id,
        organizationId: data.user.organizationId,
        userId: data.user.id,
      };
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) rows.unshift(item!);
      else rows[index] = item!;
    } else if (method.startsWith("create")) {
      const body = method === "createTask" ? { text: args[0] } : args[0];
      item = {
        tags: [],
        health: "unknown",
        attachedHostIds: [],
        hostIds: [],
        completed: false,
        sortOrder: 0,
        ...body,
        id,
        organizationId: data.user.organizationId,
        ownerId: data.user.id,
        createdAt: at,
        updatedAt: at,
      };
      // Credential material stays in encrypted grants/outbox, never public rows.
      delete item!.secret;
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) rows.unshift(item!);
      else rows[index] = item!;
    } else if (method.startsWith("delete")) {
      data.rows[collection] = rows.filter((row) => row.id !== id);
    } else if (item) {
      if (method === "setHostFavorite") item.isFavorite = args[1];
      else if (method === "markNotificationRead") item.read = true;
      else if (method === "rotateCredential") item.rotatedAt = at;
      else Object.assign(item, args[1]);
      item.updatedAt = at;
      if (collection === "tasks" && args[1]?.completed !== undefined)
        item.completedAt = args[1].completed ? at : undefined;
    }
    if (collection === "credentials") {
      const localSecrets = (data.localSecrets ??= {});
      if (method === "createCredential")
        localSecrets[id] = {
          kind: args[0].kind === "ssh_key" ? "privateKey" : "password",
          material: args[0].secret,
        };
      if (method === "rotateCredential" && item)
        localSecrets[id] = {
          kind: item.kind === "ssh_key" ? "privateKey" : "password",
          material: args[1],
        };
      if (method === "deleteCredential") delete localSecrets[id];
      if (method === "deleteCredential")
        data.grants = data.grants.filter((g) => g.credentialId !== id);
      else if (method === "rotateCredential") {
        for (const grant of data.grants.filter((g) => g.credentialId === id))
          grant.credential.material = args[1];
      } else if (
        item &&
        (method === "createCredential" || args[1]?.attachedHostIds)
      ) {
        const body = method === "createCredential" ? args[0] : args[1];
        const credential = body.secret
          ? {
              kind:
                item.kind === "ssh_key"
                  ? ("privateKey" as const)
                  : ("password" as const),
              material: body.secret,
            }
          : (localSecrets[id] ??
            data.grants.find((g) => g.credentialId === id)?.credential);
        data.grants = data.grants.filter((g) => g.credentialId !== id);
        if (credential && data.directAllowed)
          for (const hostId of item.attachedHostIds)
            data.grants.push({ hostId, credentialId: id, credential });
      }
    }
    if (method === "deleteHost")
      data.grants = data.grants.filter((g) => g.hostId !== id);
    return item;
  }
  private view() {
    const view = structuredClone(this.data);
    for (const change of view.changes) this.apply(view, change);
    return view;
  }
  async read(collection: Collection): Promise<any[]> {
    if (this.stopped) throw new Error("Sign in to access this workspace.");
    if (!this.data.rows[collection] && !this.attempted) await this.sync();
    return this.view().rows[collection] ?? [];
  }
  async identity() {
    if (this.stopped) throw new Error("Sign in to access this workspace.");
    if (!this.data.identity && !this.attempted) await this.sync();
    return this.data.identity ?? { user: this.data.user };
  }
  async mutate(method: string, args: any[]) {
    const result = await this.exclusive(async () => {
      const collection = mutations[method];
      if (!collection)
        throw new Error("This operation needs an online connection.");
      const role = this.data.user.role;
      if (
        ((collection === "hosts" && method !== "setHostFavorite") ||
          collection === "credentials") &&
        !canManageHosts(role)
      )
        throw new Error("Your role cannot edit hosts or credentials.");
      if (collection === "workspaces" && !canOpenSession(role))
        throw new Error("Your role cannot edit workspaces.");
      const existing = this.view().rows[collection]?.find(
        (row) => row.id === args[0],
      );
      if (
        collection === "snippets" &&
        existing &&
        existing.ownerId !== this.data.user.id &&
        !canManageUsers(role)
      )
        throw new Error("You cannot edit another member's snippet.");
      const nonce = randomUUID();
      const change: Change = {
        nonce,
        method,
        args,
        collection,
        id: method.startsWith("create")
          ? localEntityId(this.data.user, nonce)
          : args[0],
        at: new Date().toISOString(),
      };
      const next = structuredClone(this.data);
      next.changes.push(change);
      await this.commit(next);
      return (
        this.view().rows[collection]?.find((row) => row.id === change.id) ?? {
          ok: true,
        }
      );
    });
    if (this.running) this.rerun = true;
    void this.sync();
    return result;
  }
  async discardPending() {
    if (this.running)
      throw new Error("Wait for the current sync before discarding changes.");
    await this.exclusive(async () => {
      const next = structuredClone(this.data);
      next.changes = [];
      await this.commit(next);
      this.error = undefined;
    });
    await this.sync();
  }
  grant(hostId: string, credentialId?: string) {
    if (this.stopped) return undefined;
    const view = this.view();
    const host = view.rows.hosts?.find((row) => row.id === hostId);
    if (!view.directAllowed || !host || host.isLocal || host.isAgent)
      return undefined;
    const grant = view.grants.find(
      (g) =>
        g.hostId === hostId &&
        (!credentialId || g.credentialId === credentialId),
    );
    return grant
      ? {
          host: {
            address: host.address,
            port: host.port,
            username: host.username,
          },
          credential: grant.credential,
        }
      : undefined;
  }
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.attempted = true;
    this.running = this.reconcile().finally(() => {
      this.running = undefined;
      this.revision++;
      const again = this.rerun;
      this.rerun = false;
      if (again && !this.error && !this.stopped) void this.sync();
    });
    return this.running;
  }
  private async reconcile() {
    try {
      // Authentication is checked before replay; a different account/org must never receive this outbox.
      const identity = await this.client.me();
      if (
        identity.user.id !== this.data.user.id ||
        identity.user.organizationId !== this.data.user.organizationId
      ) {
        await this.exclusive(async () => {
          const next = structuredClone(this.data);
          next.grants = [];
          next.localSecrets = {};
          next.directAllowed = false;
          await this.commit(next);
        });
        throw new Error(
          "Workspace changed. Sign in again before syncing local changes.",
        );
      }
      if (this.stopped) return;
      this.error = undefined;
      // Capability check comes before writes: an old server must never create duplicate rows.
      let supported = false;
      try {
        const bundle = await this.bundle();
        supported = (bundle as { version?: number }).version === 1;
        await this.exclusive(async () => {
          const next = structuredClone(this.data);
          next.grants = bundle.grants;
          next.directAllowed = bundle.allowed;
          if (!bundle.allowed) next.localSecrets = {};
          for (const grant of bundle.grants)
            if (next.localSecrets) delete next.localSecrets[grant.credentialId];
          await this.commit(next);
        });
      } catch (error) {
        if ([401, 403].includes((error as { status?: number }).status ?? 0)) {
          await this.exclusive(async () => {
            const next = structuredClone(this.data);
            next.grants = [];
            next.localSecrets = {};
            next.directAllowed = false;
            await this.commit(next);
          });
        }
        this.error =
          "Offline access could not be refreshed. Check device access and update the server; your local changes are kept.";
      }
      if (!supported && this.data.changes.length)
        this.error =
          "Update the server and check device access before syncing changes. Your changes remain saved locally.";
      for (;;) {
        if (!supported) break;
        const change = this.data.changes[0];
        if (!change || this.stopped) break;
        let result: any;
        try {
          if (change.method.startsWith("create")) {
            const body =
              change.method === "createTask"
                ? { text: change.args[0] }
                : change.args[0];
            result = await this.client.transport.request(
              paths[change.collection]!,
              {
                method: "POST",
                headers: {
                  "x-onshell-offline-id": change.nonce,
                  "x-onshell-offline-organization":
                    this.data.user.organizationId,
                },
                body: JSON.stringify(body),
              },
            );
            if (result.id !== change.id)
              throw new Error(
                "Update the Onshell server before syncing desktop changes. Your changes remain saved on this computer.",
              );
          } else if (change.method === "recordSession") {
            result = await this.client.transport.request(
              `/desktop/offline-sessions/${change.id}`,
              { method: "PUT", body: JSON.stringify(change.args[1]) },
            );
          } else
            result = await (this.client as any)[change.method](...change.args);
        } catch (error) {
          if (!(
            (error as { status?: number }).status === 404 &&
            change.method.startsWith("delete")
          )) {
            this.error = `${change.method}: ${error instanceof Error ? error.message : "Sync rejected"}. Pending changes are kept locally.`;
            break;
          }
        }
        await this.exclusive(async () => {
          // The queue can grow while the request is in flight. Remove only its acknowledged item.
          if (this.data.changes[0]?.nonce !== change.nonce) return;
          const next = structuredClone(this.data);
          this.apply(next, change);
          next.changes.shift();
          if (result?.id) {
            const rows = (next.rows[change.collection] ??= []);
            const index = rows.findIndex((row) => row.id === result.id);
            if (index >= 0) rows[index] = result;
          }
          await this.commit(next);
        });
      }
      // Gather a whole snapshot before committing; failed reads never turn old lists into empty lists.
      const values = await Promise.all(
        collections.map((key) =>
          key === "audit"
            ? this.client.audit(50)
            : (this.client[key] as () => Promise<any[]>)(),
        ),
      );
      let bundle: { grants: OfflineGrant[]; allowed: boolean } | undefined;
      try {
        bundle = await this.bundle();
      } catch (error) {
        if ([401, 403].includes((error as { status?: number }).status ?? 0))
          bundle = { grants: [], allowed: false };
        else
          this.error =
            "Data synced; offline SSH credentials could not be refreshed. Check that the server is up to date.";
      }
      await this.exclusive(async () => {
        const next = structuredClone(this.data);
        next.identity = identity;
        next.user = identity.user;
        const oldCredentials = next.rows.credentials ?? [];
        collections.forEach((key, i) => {
          next.rows[key] = values[i];
        });
        for (const credential of next.rows.credentials ?? []) {
          if (
            oldCredentials.find((c) => c.id === credential.id)?.rotatedAt !==
              credential.rotatedAt &&
            next.localSecrets
          )
            delete next.localSecrets[credential.id];
        }
        if (bundle) {
          next.grants = bundle.grants;
          next.directAllowed = bundle.allowed;
        }
        // Even when the secret endpoint is unavailable, a removed host/credential loses its cached grant.
        next.grants = next.grants.filter(
          (g) =>
            next.rows.hosts!.some((h) => h.id === g.hostId) &&
            next.rows.credentials!.some((c) => c.id === g.credentialId),
        );
        for (const id of Object.keys(next.localSecrets ?? {}))
          if (!next.rows.credentials!.some((c) => c.id === id))
            delete next.localSecrets![id];
        next.lastSync = new Date().toISOString();
        await this.commit(next);
      });
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : "Cannot reach the server. Local data is available.";
    }
  }
  proxy(): ApiClient {
    return new Proxy(this.client, {
      get: (target, key: string) => {
        if ((collections as readonly string[]).includes(key))
          return () => this.read(key as Collection);
        if (key === "me") return () => this.identity();
        if (mutations[key]) return (...args: any[]) => this.mutate(key, args);
        return (target as any)[key];
      },
    });
  }
}
