/**
 * Browsing and moving files — on this machine, and on a host.
 *
 * Three sources, one shape. Local paths are read with `node:fs`; a direct file
 * session is ssh2's SFTP over a connection this machine opened; a relayed one
 * goes through the API, which re-applies the caller's host access and forwards
 * to the gateway. The renderer sees `FileEntry[]` either way and does not get to
 * care which it is looking at.
 *
 * On the local side this module reads and writes wherever the user points it,
 * which is the one place the app takes a path from the renderer rather than an
 * opaque id. That is deliberate — moving a file between your laptop and a server
 * is most of why a desktop client is worth having — but it means a renderer
 * compromise reads what the user can read. The mitigations are that the renderer
 * cannot reach the network at all (`connect-src 'none'`), and that this is the
 * only such channel, so it stays small enough to audit.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat, mkdir, rename, rm, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { Client, type SFTPWrapper } from "ssh2";
import type { FileEntry, FileListing, FileSessionOpened } from "../../shared/ipc.js";
import { requireApi } from "./session.js";
import { leaseFor } from "./ssh.js";

/** Largest file the built-in editor will open. Bigger ones must be transferred. */
const MAX_TEXT_BYTES = 1024 * 1024;

interface FileBackend {
  kind: "local" | "direct" | "relay";
  label: string;
  list(target: string): Promise<FileListing>;
  read(target: string): Promise<{ content: string; truncated: boolean }>;
  write(target: string, content: string): Promise<void>;
  mkdir(target: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(target: string, recursive: boolean): Promise<void>;
  /** Streams bytes out of this backend into a local file. */
  download(remotePath: string, localPath: string): Promise<void>;
  /** Streams a local file into this backend. */
  upload(localPath: string, remotePath: string): Promise<void>;
  close(): void;
}

const sessions = new Map<string, FileBackend>();

/* ------------------------------------------------------------------ local */

function entryFromStats(name: string, stats: { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number }): FileEntry {
  return {
    name,
    type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
    size: stats.size,
    modifiedAt: Math.floor(stats.mtimeMs / 1000)
  };
}

function localBackend(): FileBackend {
  return {
    kind: "local",
    label: "This computer",
    async list(target) {
      const resolved = path.resolve(target || homedir());
      const names = await readdir(resolved);
      const entries: FileEntry[] = [];
      for (const name of names) {
        try {
          entries.push(entryFromStats(name, await stat(path.join(resolved, name))));
        } catch {
          // A dangling symlink or a directory the user cannot stat. Listing the
          // rest is more useful than failing the whole directory.
          entries.push({ name, type: "other", size: 0, modifiedAt: 0 });
        }
      }
      return { path: resolved, entries };
    },
    async read(target) {
      const resolved = path.resolve(target);
      const info = await stat(resolved);
      if (info.size > MAX_TEXT_BYTES) return { content: "", truncated: true };
      return { content: await readFile(resolved, "utf8"), truncated: false };
    },
    async write(target, content) {
      await writeFile(path.resolve(target), content, "utf8");
    },
    async mkdir(target) {
      await mkdir(path.resolve(target), { recursive: true });
    },
    async move(from, to) {
      await rename(path.resolve(from), path.resolve(to));
    },
    async remove(target, recursive) {
      await rm(path.resolve(target), { recursive, force: false });
    },
    async download(from, to) {
      await pipeline(createReadStream(path.resolve(from)), createWriteStream(path.resolve(to)));
    },
    async upload(from, to) {
      await pipeline(createReadStream(path.resolve(from)), createWriteStream(path.resolve(to)));
    },
    close() {
      // Nothing is held open.
    }
  };
}

/* ----------------------------------------------------------------- direct */

/** Wraps ssh2's callback SFTP in promises, and normalises its errors. */
function sftpBackend(client: Client, sftp: SFTPWrapper, label: string): FileBackend {
  // ssh2's callbacks pass `null` for success, not `undefined`, so the parameter
  // is typed to match rather than fought with a cast at every call site.
  const call = <T>(run: (done: (error: Error | null | undefined, value: T) => void) => void) =>
    new Promise<T>((resolve, reject) => {
      run((error, value) => (error ? reject(translate(error)) : resolve(value)));
    });

  /** SFTP status codes are numbers; the message alone is "Failure". */
  function translate(error: Error & { code?: number }) {
    if (error.code === 2) return new Error("That path does not exist.");
    if (error.code === 3) return new Error("Permission denied.");
    if (error.code === 4) return new Error("The host refused that operation.");
    return error;
  }

  return {
    kind: "direct",
    label,
    async list(target) {
      const resolved = target || ".";
      const absolute = await call<string>((done) => sftp.realpath(resolved, done));
      const list = await call<Array<{ filename: string; attrs: { size: number; mtime: number; mode: number } }>>(
        (done) => sftp.readdir(absolute, done)
      );
      return {
        path: absolute,
        entries: list.map((item) => ({
          name: item.filename,
          // The POSIX file-type bits: 0o040000 directory, 0o100000 regular.
          type:
            (item.attrs.mode & 0o170000) === 0o040000
              ? "directory"
              : (item.attrs.mode & 0o170000) === 0o100000
                ? "file"
                : "other",
          size: item.attrs.size,
          modifiedAt: item.attrs.mtime
        }))
      };
    },
    async read(target) {
      const attrs = await call<{ size: number }>((done) => sftp.stat(target, done));
      if (attrs.size > MAX_TEXT_BYTES) return { content: "", truncated: true };
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(target);
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", (error: Error) => reject(translate(error)));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
      });
      return { content: buffer.toString("utf8"), truncated: false };
    },
    write(target, content) {
      return new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(target);
        stream.on("error", (error: Error) => reject(translate(error)));
        stream.on("close", () => resolve());
        stream.end(Buffer.from(content, "utf8"));
      });
    },
    mkdir: (target) => call<void>((done) => sftp.mkdir(target, done)),
    move: (from, to) => call<void>((done) => sftp.rename(from, to, done)),
    async remove(target, recursive) {
      const attrs = await call<{ mode: number }>((done) => sftp.stat(target, done));
      const isDirectory = (attrs.mode & 0o170000) === 0o040000;
      if (!isDirectory) return call<void>((done) => sftp.unlink(target, done));
      if (!recursive) throw new Error("That is a directory. Deleting it needs the recursive option.");
      const listing = await this.list(target);
      for (const entry of listing.entries) {
        await this.remove(path.posix.join(listing.path, entry.name), true);
      }
      await call<void>((done) => sftp.rmdir(target, done));
    },
    download: (from, to) =>
      pipeline(sftp.createReadStream(from), createWriteStream(path.resolve(to))),
    upload: (from, to) => pipeline(createReadStream(path.resolve(from)), sftp.createWriteStream(to)),
    close() {
      client.end();
    }
  };
}

/* ------------------------------------------------------------------ relay */

/**
 * Through the API, which re-checks host access and talks to the gateway.
 *
 * Deliberately does not carry streaming transfers: the relayed file routes are
 * text-oriented and a large binary would be base64 in and out of two hops. A
 * transfer on this backend tells the user to use direct mode rather than doing
 * it badly.
 */
function relayBackend(sessionId: string, label: string): FileBackend {
  const client = requireApi();
  const unsupported = () => {
    throw new Error("Transfers need a direct connection. Open this host directly to move files.");
  };

  return {
    kind: "relay",
    label,
    async list(target) {
      const payload = await client.listFiles(sessionId, target || ".");
      return {
        path: payload.path ?? target,
        entries: (payload.entries ?? []) as FileEntry[]
      };
    },
    async read(target) {
      const file = await client.readFile(sessionId, target);
      if (file.tooLarge) return { content: "", truncated: true };
      if (file.binary) throw new Error("That file is not text.");
      return { content: file.content ?? "", truncated: false };
    },
    async write(target, content) {
      await client.writeFile(sessionId, target, content);
    },
    async mkdir(target) {
      await client.makeDirectory(sessionId, target);
    },
    async move(from, to) {
      await client.renamePath(sessionId, from, to);
    },
    async remove(target, recursive) {
      await client.deletePath(sessionId, target, recursive);
    },
    download: unsupported,
    upload: unsupported,
    close() {
      void client.closeSession(sessionId).catch(() => undefined);
    }
  };
}

/* --------------------------------------------------------------- sessions */

export type FileSessionTarget =
  | { kind: "local" }
  | { kind: "direct"; hostId: string; credentialId?: string }
  | { kind: "relay"; hostId: string; credentialId?: string };

export async function openFileSession(target: FileSessionTarget): Promise<FileSessionOpened> {
  const id = randomUUID();

  if (target.kind === "local") {
    const backend = localBackend();
    sessions.set(id, backend);
    return { fileSessionId: id, mode: "local", label: backend.label, startPath: homedir() };
  }

  if (target.kind === "relay") {
    const client = requireApi();
    const { session } = await client.openSession({
      hostId: target.hostId,
      protocol: "sftp",
      credentialId: target.credentialId
    });
    const hosts = await client.hosts();
    const label = hosts.find((host) => host.id === target.hostId)?.name ?? "Host";
    sessions.set(id, relayBackend(session.id, label));
    return { fileSessionId: id, mode: "relay", label, startPath: "." };
  }

  // Direct: its own SSH connection, from its own lease. Sharing the terminal's
  // connection would tie a file browser's lifetime to a shell the user may well
  // close first.
  const lease = await leaseFor(target.hostId, target.credentialId, "sftp");
  const material = Buffer.from(lease.credential.material, "utf8");
  const label = `${lease.host.username ? `${lease.host.username}@` : ""}${lease.host.address}`;
  const client = new Client();

  const backend = await new Promise<FileBackend>((resolve, reject) => {
    client.on("ready", () => {
      material.fill(0);
      client.sftp((error, sftp) => {
        if (error) {
          client.end();
          return reject(new Error("Connected, but the host refused an SFTP session."));
        }
        resolve(sftpBackend(client, sftp, label));
      });
    });
    client.on("error", () => {
      material.fill(0);
      reject(new Error(`Could not reach ${lease.host.address} from this machine.`));
    });
    client.connect({
      host: lease.host.address,
      port: lease.host.port,
      username: lease.host.username,
      ...(lease.credential.kind === "privateKey"
        ? { privateKey: material }
        : { password: material.toString("utf8") }),
      readyTimeout: 20_000
    });
  });

  sessions.set(id, backend);
  return { fileSessionId: id, mode: "direct", label, startPath: "." };
}

function backendFor(fileSessionId: string) {
  const backend = sessions.get(fileSessionId);
  if (!backend) throw new Error("That file session is no longer open.");
  return backend;
}

export const files = {
  list: (id: string, target: string) => backendFor(id).list(target),
  read: (id: string, target: string) => backendFor(id).read(target),
  write: (id: string, target: string, content: string) => backendFor(id).write(target, content),
  mkdir: (id: string, target: string) => backendFor(id).mkdir(target),
  move: (id: string, from: string, to: string) => backendFor(id).move(from, to),
  remove: (id: string, target: string, recursive: boolean) => backendFor(id).remove(target, recursive),

  /**
   * Moves one file between two open sessions.
   *
   * Always through this process: the two ends may be a laptop and a server with
   * no route between them, and the machine holding both connections is the only
   * place the bytes can meet.
   */
  async transfer(fromId: string, fromPath: string, toId: string, toPath: string) {
    const source = backendFor(fromId);
    const destination = backendFor(toId);

    if (source.kind === "local") return destination.upload(fromPath, toPath);
    if (destination.kind === "local") return source.download(fromPath, toPath);

    throw new Error("Transferring between two remote hosts is not supported from the desktop app yet.");
  },

  close(id: string) {
    sessions.get(id)?.close();
    sessions.delete(id);
  },

  closeAll() {
    for (const backend of sessions.values()) backend.close();
    sessions.clear();
  }
};
