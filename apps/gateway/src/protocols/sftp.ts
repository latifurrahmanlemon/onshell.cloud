/**
 * SFTP transport plus the transport-agnostic file operations behind the
 * console's dual-pane file manager.
 *
 * Every operation (list, read, write, mkdir, rename, remove, copy) is written
 * once against the small `FileTransport` surface below. SSH sessions get the
 * implementation in this file; the built-in local host gets an fs/promises one in
 * protocols/local.ts. That is what makes copy work between *any* two open
 * sessions — remote↔remote, local↔remote, remote↔local, local↔local — instead of
 * needing a hand-written case per pair.
 *
 * Copies stream: both sessions live in this process, so the bytes go straight
 * from the source session's channel into the destination session's. They never
 * pass through the API service or the browser.
 */
import { posix } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileEntryWithStats, Stats } from "ssh2";
import { createGatewaySession, updateGatewaySession, type GatewaySession } from "../registry.js";
import { attachSshConnection, getSftp } from "./ssh-connections.js";

export interface OpenSftpSessionInput {
  hostId: string;
  address: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  startPath?: string;
}

export function openSftpSession(input: OpenSftpSessionInput): GatewaySession {
  const session = createGatewaySession({
    protocol: "sftp",
    hostId: input.hostId,
    metadata: {
      address: input.address,
      port: input.port,
      username: input.username,
      startPath: input.startPath ?? "/"
    }
  });

  attachSshConnection(session, input);

  return updateGatewaySession(session.id, {}) as GatewaySession;
}

/* ------------------------------------------------------------- vocabulary */

/**
 * Largest file the console may open in its editor or save back. Mirrors
 * MAX_EDITABLE_FILE_BYTES in the web client — anything bigger has to be moved
 * with a copy, not edited as text.
 */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

/**
 * Deepest directory nesting a copy will walk.
 *
 * A real tree never gets close. This is a stop for the pathological case: two
 * sessions that reach the *same* filesystem by different routes (two SSH
 * sessions to one host) cannot be recognised as such from here, so copying a
 * directory into its own subtree across them would otherwise recurse forever.
 */
const MAX_COPY_DEPTH = 64;

export type RemoteEntryType = "file" | "directory" | "other";

export interface RemoteFileEntry {
  name: string;
  type: RemoteEntryType;
  size: number;
  /** Unix seconds. 0 when the entry could not be stat'ed. */
  modifiedAt: number;
}

export interface RemoteDirectory {
  /** The path the transport resolved — "." becomes an absolute path. */
  path: string;
  entries: RemoteFileEntry[];
}

export interface RemoteFileContent {
  path: string;
  size: number;
  /** UTF-8 text. Absent when `binary` or `tooLarge` is set. */
  content?: string;
  binary: boolean;
  tooLarge: boolean;
}

export interface PathStat {
  type: RemoteEntryType;
  size: number;
  modifiedAt: number;
}

/**
 * A file failure with a name the console can act on ("too large", "permission
 * denied") rather than an opaque 500. Each transport translates its own native
 * errors into these so the API sees one vocabulary from both.
 */
export class FileOperationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400, message?: string) {
    super(message ?? code);
    this.name = "FileOperationError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The filesystem surface a transport has to provide. Paths handed to everything
 * except `resolve` are already absolute, as returned by `resolve`.
 */
export interface FileTransport {
  /**
   * Identifies the filesystem this transport reaches. Two transports sharing a
   * key are known to be the same filesystem, which is what lets a copy refuse a
   * directory being pasted into itself.
   */
  readonly filesystemKey: string;
  /** Turns a client-supplied path into an absolute one for this transport. */
  resolve(requested: string): Promise<string>;
  join(directory: string, name: string): string;
  basename(path: string): string;
  stat(path: string): Promise<PathStat>;
  /** Does not follow symlinks — used wherever following one would be destructive. */
  lstat(path: string): Promise<PathStat>;
  readdir(path: string): Promise<RemoteFileEntry[]>;
  /** Creates one level only; a missing parent is an error, as with mkdir(2). */
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  createReadStream(path: string): Readable;
  createWriteStream(path: string): Writable;
  /** Releases the channel or handle this transport holds. Safe to call twice. */
  close(): void;
}

/* -------------------------------------------------------------- operations */

/**
 * Best-effort stat used for "does this already exist?" questions.
 *
 * A path that cannot be stat'ed is reported as absent: the difference between
 * missing and unreadable does not change what the callers here do next, and the
 * real error resurfaces from the operation that follows.
 */
async function statOrNull(transport: FileTransport, path: string): Promise<PathStat | null> {
  try {
    return await transport.stat(path);
  } catch {
    return null;
  }
}

export async function listDirectory(transport: FileTransport, requested: string): Promise<RemoteDirectory> {
  const path = await transport.resolve(requested);
  return { path, entries: await transport.readdir(path) };
}

/**
 * Strict UTF-8 decode, returning null for anything the editor must not open.
 *
 * NUL bytes count as binary even though they decode cleanly: a file containing
 * them is not text, and handing the editor mojibake it would then save back over
 * the original is worse than refusing.
 */
function decodeUtf8(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

export async function readTextFile(transport: FileTransport, requested: string): Promise<RemoteFileContent> {
  const path = await transport.resolve(requested);
  const info = await transport.stat(path);
  if (info.type === "directory") throw new FileOperationError("path_is_a_directory", 400);
  if (info.type !== "file") throw new FileOperationError("not_a_regular_file", 400);
  if (info.size > MAX_TEXT_FILE_BYTES) return { path, size: info.size, binary: false, tooLarge: true };

  // The ceiling is re-checked while reading rather than trusted from the stat:
  // /proc-style files report size 0, and an ordinary file can grow between the
  // two calls.
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = transport.createReadStream(path);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      size += buffer.length;
      if (size > MAX_TEXT_FILE_BYTES) {
        return { path, size: Math.max(info.size, size), binary: false, tooLarge: true };
      }
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }

  const text = decodeUtf8(Buffer.concat(chunks));
  return text === null
    ? { path, size, binary: true, tooLarge: false }
    : { path, size, binary: false, tooLarge: false, content: text };
}

export async function writeTextFile(transport: FileTransport, requested: string, content: string) {
  // Bytes, not characters: a 1 MiB cap measured in UTF-16 units would let a
  // multi-byte file through at up to three times the limit.
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_TEXT_FILE_BYTES) throw new FileOperationError("file_too_large", 413);

  const path = await transport.resolve(requested);
  const existing = await statOrNull(transport, path);
  if (existing && existing.type !== "file") throw new FileOperationError("not_a_regular_file", 400);

  await pipeline(Readable.from([Buffer.from(content, "utf8")]), transport.createWriteStream(path));
  return { path, size };
}

export async function makeDirectory(transport: FileTransport, requested: string) {
  const path = await transport.resolve(requested);
  if (await statOrNull(transport, path)) throw new FileOperationError("path_exists", 409);
  await transport.mkdir(path);
  return { path };
}

export async function renamePath(transport: FileTransport, requestedFrom: string, requestedTo: string) {
  const from = await transport.resolve(requestedFrom);
  const to = await transport.resolve(requestedTo);
  if (from === to) return { path: to };
  // Refuse to clobber. SFTP rename is not required to overwrite (so the same
  // gesture would succeed on one server and fail on another), and silently
  // destroying the file at the destination is never what a rename in a file
  // browser should do.
  if (await statOrNull(transport, to)) throw new FileOperationError("path_exists", 409);
  await transport.rename(from, to);
  return { path: to };
}

async function removeTree(transport: FileTransport, path: string): Promise<void> {
  for (const entry of await transport.readdir(path)) {
    const child = transport.join(path, entry.name);
    // lstat rather than the listing's type: a symlink pointing at a directory
    // must be unlinked, never walked into and emptied.
    const info = await transport.lstat(child);
    if (info.type === "directory") await removeTree(transport, child);
    else await transport.unlink(child);
  }

  await transport.rmdir(path);
}

export async function removePath(transport: FileTransport, requested: string, recursive: boolean) {
  const path = await transport.resolve(requested);
  // basename("/") is empty on both posix and win32, so this catches every form
  // of "delete the whole filesystem" without a platform special case.
  if (transport.basename(path) === "") throw new FileOperationError("refusing_to_remove_root", 400);

  const info = await transport.lstat(path);
  if (info.type !== "directory") {
    await transport.unlink(path);
    return { path };
  }
  if (!recursive) {
    throw new FileOperationError(
      "recursive_required",
      400,
      "That path is a directory. Deleting it has to be requested recursively."
    );
  }

  await removeTree(transport, path);
  return { path };
}

async function ensureDirectory(transport: FileTransport, path: string) {
  const existing = await statOrNull(transport, path);
  if (existing?.type === "directory") return;
  if (existing) throw new FileOperationError("destination_is_a_file", 409);
  await transport.mkdir(path);
}

/** Counts what actually crossed the wire, so the console can report real bytes. */
function countingStage(totals: { bytes: number }) {
  return async function* (chunks: AsyncIterable<Buffer>) {
    for await (const chunk of chunks) {
      totals.bytes += chunk.length;
      yield chunk;
    }
  };
}

async function copyInto(
  source: FileTransport,
  from: string,
  target: FileTransport,
  to: string,
  info: PathStat,
  totals: { bytes: number; files: number },
  depth: number
): Promise<void> {
  if (depth > MAX_COPY_DEPTH) throw new FileOperationError("copy_too_deep", 400);

  if (info.type === "directory") {
    await ensureDirectory(target, to);
    for (const entry of await source.readdir(from)) {
      const child = source.join(from, entry.name);
      // stat, not the listing's type: a symlink is copied as the file it points
      // at, because a link recreated on another host would dangle.
      const childInfo = await source.stat(child);
      await copyInto(source, child, target, target.join(to, entry.name), childInfo, totals, depth + 1);
    }
    return;
  }

  // Sockets, fifos and devices have no contents worth transferring — skipping
  // them keeps a directory copy from hanging on an open() that never returns.
  if (info.type !== "file") return;

  // Both streams belong to this process, so the payload moves from the source
  // session's channel straight into the destination session's.
  await pipeline(source.createReadStream(from), countingStage(totals), target.createWriteStream(to));
  totals.files += 1;
}

/**
 * Copies a file or directory from one session to another.
 *
 * `requestedTo` names the copy itself, which is what the console sends: it pastes
 * "<destination directory>/<source name>". Two conveniences on top of that:
 * pasting a *file* onto an existing directory drops it inside that directory
 * (the plain paste-into-folder gesture), and pasting a *directory* onto one that
 * already exists merges into it rather than nesting a second copy underneath —
 * pasting the same folder twice should not produce "work/work".
 *
 * Same-named files inside a merge are overwritten. Nothing at the destination is
 * ever deleted, so a merge only ever adds or replaces.
 */
export async function copyPath(
  source: FileTransport,
  requestedFrom: string,
  target: FileTransport,
  requestedTo: string
) {
  const from = await source.resolve(requestedFrom);
  const info = await source.stat(from);
  const requested = await target.resolve(requestedTo);
  const existing = await statOrNull(target, requested);
  const to =
    existing?.type === "directory" && info.type !== "directory"
      ? target.join(requested, source.basename(from))
      : requested;

  if (source.filesystemKey === target.filesystemKey) {
    const escapedDirectory = to.length > from.length && to.startsWith(from) && (to[from.length] === "/" || to[from.length] === "\\");
    if (to === from || escapedDirectory) throw new FileOperationError("copy_into_itself", 400);
  }

  const totals = { bytes: 0, files: 0 };
  await copyInto(source, from, target, to, info, totals, 0);
  return { path: to, ...totals };
}

/* ------------------------------------------------------------ ssh transport */

/** SFTP status codes worth naming for the console. */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;
const SFTP_FILE_ALREADY_EXISTS = 11;

function fromSftpError(error: unknown): FileOperationError {
  if (error instanceof FileOperationError) return error;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === SFTP_NO_SUCH_FILE) return new FileOperationError("path_not_found", 404);
  if (code === SFTP_PERMISSION_DENIED) return new FileOperationError("permission_denied", 403);
  if (code === SFTP_FILE_ALREADY_EXISTS) return new FileOperationError("path_exists", 409);
  return new FileOperationError(
    "sftp_operation_failed",
    502,
    error instanceof Error ? error.message : undefined
  );
}

function entryType(stats: Stats): RemoteEntryType {
  return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
}

function toPathStat(stats: Stats): PathStat {
  return { type: entryType(stats), size: stats.size ?? 0, modifiedAt: stats.mtime ?? 0 };
}

/**
 * Opens an SFTP channel for a session and exposes it as a `FileTransport`.
 *
 * One channel per operation, released by `close()`: SFTP channels are cheap
 * next to the SSH connection they ride on, and holding one open for the lifetime
 * of a session would leak a channel per session that is never closed cleanly.
 * A recursive copy or delete reuses the single channel it was given.
 */
export async function createSftpTransport(sessionId: string): Promise<FileTransport> {
  const sftp = await getSftp(sessionId);
  /** realpath(".") — the directory the SSH login landed in. Resolved on demand. */
  let root: string | null = null;
  let closed = false;

  const stat = (path: string, followLinks: boolean) =>
    new Promise<PathStat>((resolve, reject) => {
      const handle = (error: Error | undefined, stats: Stats) => {
        if (error) {
          reject(fromSftpError(error));
          return;
        }
        resolve(toPathStat(stats));
      };

      if (followLinks) sftp.stat(path, handle);
      else sftp.lstat(path, handle);
    });

  const run = (action: (done: (error?: Error | null) => void) => void) =>
    new Promise<void>((resolve, reject) => {
      action((error) => {
        if (error) {
          reject(fromSftpError(error));
          return;
        }
        resolve();
      });
    });

  return {
    filesystemKey: `sftp:${sessionId}`,

    /**
     * Absolute paths are honoured as given: the remote server owns its own
     * permission model, and reaching outside the login directory is the whole
     * point of a file manager (the operator has a shell on the same host).
     *
     * Relative paths — "." and anything containing ".." — are anchored at the
     * directory the session started in, as the remote server reports it via
     * realpath("."). A relative path that would climb out of that anchor is
     * refused with `path_escapes_session_root` instead of quietly resolving
     * somewhere the caller did not name.
     */
    async resolve(requested) {
      const wanted = requested.trim() === "" ? "." : requested;
      if (posix.isAbsolute(wanted)) return posix.normalize(wanted);

      root ??= await new Promise<string>((resolve, reject) => {
        sftp.realpath(".", (error, absolute) => {
          if (error) {
            reject(fromSftpError(error));
            return;
          }
          resolve(absolute);
        });
      });

      const resolved = posix.normalize(posix.join(root, wanted));
      const prefix = root.endsWith("/") ? root : `${root}/`;
      if (resolved !== root && !resolved.startsWith(prefix)) {
        throw new FileOperationError("path_escapes_session_root", 400);
      }

      return resolved;
    },

    join: (directory, name) => posix.join(directory, name),
    basename: (path) => posix.basename(path),
    stat: (path) => stat(path, true),
    lstat: (path) => stat(path, false),

    async readdir(path) {
      const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(path, (error, list) => {
          if (error) {
            reject(fromSftpError(error));
            return;
          }
          resolve(list);
        });
      });

      return Promise.all(
        entries.map(async (entry): Promise<RemoteFileEntry> => {
          const base = { name: entry.filename, size: entry.attrs.size ?? 0, modifiedAt: entry.attrs.mtime ?? 0 };
          if (!entry.attrs.isSymbolicLink()) return { ...base, type: entryType(entry.attrs) };

          // readdir describes the link itself, but the console has to know
          // whether opening it navigates or edits. A dangling link stays "other".
          try {
            const info = await stat(posix.join(path, entry.filename), true);
            return { ...base, type: info.type };
          } catch {
            return { ...base, type: "other" };
          }
        })
      );
    },

    mkdir: (path) => run((done) => sftp.mkdir(path, done)),
    rename: (from, to) => run((done) => sftp.rename(from, to, done)),
    unlink: (path) => run((done) => sftp.unlink(path, done)),
    rmdir: (path) => run((done) => sftp.rmdir(path, done)),
    createReadStream: (path) => sftp.createReadStream(path),
    createWriteStream: (path) => sftp.createWriteStream(path),

    close() {
      if (closed) return;
      closed = true;
      sftp.end();
    }
  };
}
