/**
 * The filesystem of this machine, answered over the tunnel.
 *
 * These handlers mirror the gateway's `FileTransport` one method at a time, so
 * the console's existing file manager works against a customer's own computer
 * without a second implementation anywhere.
 *
 * Bulk contents do not travel as JSON. A read or a write opens a channel and the
 * bytes move as binary frames, the same way pty output does, with a credit
 * window so neither end can be flooded by the other.
 */
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  STREAM_WINDOW_BYTES,
  fsPathParamsSchema,
  fsRenameParamsSchema,
  fsResolveParamsSchema,
  fsStreamParamsSchema,
  type PathStatPayload,
  type RemoteFileEntryPayload
} from "@onshell/agent-protocol";
import { recordAudit } from "./audit.js";

/** A failure with a name the console can act on, rather than an opaque 500. */
export class FileError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "FileError";
  }
}

/**
 * Ceiling on concurrent file streams for one agent, for the same reason
 * terminals have one: a confused or hostile gateway must not be able to open
 * file handles on somebody's laptop without bound.
 */
const MAX_STREAMS = 64;

export interface StreamHooks {
  sendData(channelId: number, chunk: Buffer): void;
  sendEnd(channelId: number): void;
  sendError(channelId: number, code: string, message?: string): void;
  sendCredit(channelId: number, bytes: number): void;
}

/**
 * Resolves a gateway-supplied path against this machine's filesystem.
 *
 * Absolute paths are honoured. That is deliberate and matches the local
 * transport: whoever is asking already has a shell on this machine, so confining
 * the file browser to a subtree would be theatre while `cd /` sits one keystroke
 * away in the terminal tab.
 *
 * A *relative* path is resolved under the session's start directory and then
 * required to stay there, so `../../etc` fails loudly instead of silently
 * landing somewhere the caller did not think it was.
 */
function resolvePath(startPath: string, requested: string) {
  if (!requested || requested.trim() === "" || requested === "." || requested === "./") return resolve(startPath);

  const normalized = normalize(requested);
  if (isAbsolute(normalized)) return resolve(normalized);

  const root = resolve(startPath);
  const resolved = resolve(join(root, normalized));
  if (resolved !== root && !resolved.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new FileError("path_escapes_session_root");
  }

  return resolved;
}

/** Translates a Node fs error into the vocabulary the file routes report. */
function fromFsError(error: unknown): FileError {
  if (error instanceof FileError) return error;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  switch (code) {
    case "ENOENT":
      return new FileError("path_not_found");
    case "EEXIST":
      return new FileError("path_exists");
    case "EACCES":
    case "EPERM":
      return new FileError("permission_denied");
    case "ENOTDIR":
      return new FileError("not_a_directory");
    case "EISDIR":
      return new FileError("path_is_a_directory");
    case "ENOTEMPTY":
      return new FileError("directory_not_empty");
    default:
      return new FileError("file_operation_failed", error instanceof Error ? error.message : undefined);
  }
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw fromFsError(error);
  }
}

function toPathStat(info: { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number }): PathStatPayload {
  return {
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    size: info.size,
    modifiedAt: Math.floor(info.mtimeMs / 1000)
  };
}

interface ReadStreamState {
  kind: "read";
  stream: ReadStream;
  /** Bytes this side may still send before it must wait for credit. */
  credit: number;
}

interface WriteStreamState {
  kind: "write";
  stream: WriteStream;
  /** Bytes written since the last credit was granted back. */
  sinceCredit: number;
  /** Set once the gateway says it has sent everything. */
  ending: boolean;
  /** A `drain` handler is already registered; see `write`. */
  awaitingDrain: boolean;
}

type StreamState = ReadStreamState | WriteStreamState;

export class FileService {
  private readonly streams = new Map<number, StreamState>();

  constructor(private readonly hooks: StreamHooks) {}

  /** Routes one `fs.*` call. Throws `FileError`, which the caller reports as `rpc-err`. */
  async call(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "fs.resolve": {
        const input = fsResolveParamsSchema.parse(params);
        return { path: resolvePath(input.startPath ?? homedir(), input.requested) };
      }
      case "fs.stat": {
        const { path } = fsPathParamsSchema.parse(params);
        return guard(async () => toPathStat(await stat(path)));
      }
      case "fs.lstat": {
        const { path } = fsPathParamsSchema.parse(params);
        return guard(async () => toPathStat(await lstat(path)));
      }
      case "fs.readdir": {
        const { path } = fsPathParamsSchema.parse(params);
        return { entries: await this.readdir(path) };
      }
      case "fs.mkdir": {
        const { path } = fsPathParamsSchema.parse(params);
        await guard(async () => void (await mkdir(path)));
        return { ok: true };
      }
      case "fs.rename": {
        const { from, to } = fsRenameParamsSchema.parse(params);
        await guard(() => rename(from, to));
        void recordAudit("file.written", { path: to, renamedFrom: from });
        return { ok: true };
      }
      case "fs.unlink": {
        const { path } = fsPathParamsSchema.parse(params);
        await guard(() => unlink(path));
        void recordAudit("file.removed", { path });
        return { ok: true };
      }
      case "fs.rmdir": {
        const { path } = fsPathParamsSchema.parse(params);
        await guard(() => rmdir(path));
        void recordAudit("file.removed", { path, directory: true });
        return { ok: true };
      }
      case "fs.openRead": {
        const input = fsStreamParamsSchema.parse(params);
        await this.openRead(input.ch, input.path);
        void recordAudit("file.read", { path: input.path });
        return { ok: true };
      }
      case "fs.openWrite": {
        const input = fsStreamParamsSchema.parse(params);
        await this.openWrite(input.ch, input.path);
        void recordAudit("file.written", { path: input.path });
        return { ok: true };
      }
      default:
        throw new FileError("method_not_supported", method);
    }
  }

  private async readdir(path: string): Promise<RemoteFileEntryPayload[]> {
    const entries = await guard(() => readdir(path, { withFileTypes: true }));

    return Promise.all(
      entries.map(async (entry): Promise<RemoteFileEntryPayload> => {
        const fallbackType = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
        // A dangling symlink, or an entry this account cannot stat, must not
        // fail the whole listing — report it with zeroes instead.
        try {
          const info = await stat(join(path, entry.name));
          return {
            name: entry.name,
            type: entry.isSymbolicLink() ? (info.isDirectory() ? "directory" : "file") : fallbackType,
            size: info.size,
            modifiedAt: Math.floor(info.mtimeMs / 1000)
          };
        } catch {
          return { name: entry.name, type: fallbackType, size: 0, modifiedAt: 0 };
        }
      })
    );
  }

  /* ------------------------------- streams ------------------------------- */

  private reserve(channelId: number) {
    if (this.streams.has(channelId)) throw new FileError("channel_in_use");
    if (this.streams.size >= MAX_STREAMS) throw new FileError("too_many_streams");
  }

  private async openRead(channelId: number, path: string) {
    this.reserve(channelId);

    // Stat'ed first so a missing file or a directory fails as an rpc error the
    // console can render, rather than as a stream that dies a moment later.
    const info = await guard(() => stat(path));
    if (info.isDirectory()) throw new FileError("path_is_a_directory");

    const stream = createReadStream(path);
    const state: ReadStreamState = { kind: "read", stream, credit: STREAM_WINDOW_BYTES };
    this.streams.set(channelId, state);

    stream.on("data", (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      state.credit -= buffer.length;
      this.hooks.sendData(channelId, buffer);
      // Out of credit: stop reading until the far side says it has drained.
      if (state.credit <= 0) stream.pause();
    });
    stream.on("end", () => {
      this.streams.delete(channelId);
      this.hooks.sendEnd(channelId);
    });
    stream.on("error", (error) => {
      this.streams.delete(channelId);
      this.hooks.sendError(channelId, fromFsError(error).code);
    });
  }

  private async openWrite(channelId: number, path: string) {
    this.reserve(channelId);

    const stream = createWriteStream(path);
    const state: WriteStreamState = { kind: "write", stream, sinceCredit: 0, ending: false, awaitingDrain: false };

    // A path that cannot be opened at all (missing directory, no permission)
    // must fail the rpc rather than the stream, so the console can say why.
    await new Promise<void>((resolveOpen, rejectOpen) => {
      stream.once("open", () => resolveOpen());
      stream.once("error", (error) => rejectOpen(fromFsError(error)));
    });

    this.streams.set(channelId, state);
    stream.on("error", (error) => {
      this.streams.delete(channelId);
      this.hooks.sendError(channelId, fromFsError(error).code);
    });
  }

  /**
   * Whether this channel is a file stream.
   *
   * Terminals and file streams share one channel id space (the gateway
   * allocates from it), so an arriving binary frame has to be routed to
   * whichever owns the channel.
   */
  owns(channelId: number) {
    return this.streams.has(channelId);
  }

  /** Incoming bytes for a write stream. */
  write(channelId: number, payload: Buffer) {
    const state = this.streams.get(channelId);
    if (state?.kind !== "write") return;

    const flushed = state.stream.write(payload);
    state.sinceCredit += payload.length;

    const release = () => {
      if (state.sinceCredit === 0) return;
      this.hooks.sendCredit(channelId, state.sinceCredit);
      state.sinceCredit = 0;
    };

    // Credit is released only once the bytes are actually out of memory: while
    // the file is keeping up, immediately; while it is not, after `drain`.
    if (flushed) {
      release();
      return;
    }

    // One handler, not one per chunk. A backed-up write takes many chunks
    // before it drains, and attaching a listener to each is both a leak and a
    // MaxListenersExceededWarning — the accumulated bytes are released by the
    // single pending handler anyway.
    if (state.awaitingDrain) return;
    state.awaitingDrain = true;
    state.stream.once("drain", () => {
      state.awaitingDrain = false;
      release();
    });
  }

  /** The far side finished sending. */
  end(channelId: number) {
    const state = this.streams.get(channelId);
    if (!state) return;

    if (state.kind === "read") {
      // The reader gave up early (a cancelled download).
      this.streams.delete(channelId);
      state.stream.destroy();
      return;
    }

    state.ending = true;
    state.stream.end(() => {
      this.streams.delete(channelId);
      // Answered only after the data is flushed and the handle closed, so the
      // far side learns the file is really on disk rather than merely sent.
      this.hooks.sendEnd(channelId);
    });
  }

  /** More room on the far side: keep reading. */
  credit(channelId: number, bytes: number) {
    const state = this.streams.get(channelId);
    if (state?.kind !== "read") return;

    state.credit += bytes;
    if (state.credit > 0) state.stream.resume();
  }

  /** The far side failed, or the channel was abandoned. */
  abort(channelId: number) {
    const state = this.streams.get(channelId);
    if (!state) return;
    this.streams.delete(channelId);
    state.stream.destroy();
  }

  /** Tunnel lost: every stream is unrecoverable, unlike a terminal. */
  abortAll() {
    for (const channelId of [...this.streams.keys()]) this.abort(channelId);
  }
}
