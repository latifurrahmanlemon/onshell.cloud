/**
 * A customer's machine as a `FileTransport`.
 *
 * Every file operation in protocols/sftp.ts — list, read, write, mkdir, rename,
 * remove, and copy between any two open sessions — is written once against that
 * interface. Implementing it here is what makes the console's existing file
 * manager work against an agent host with no changes to a single route.
 *
 * Metadata calls are `fs.*` RPCs. Contents are not: a read or a write opens a
 * channel and the bytes travel as binary frames under a credit window, so a
 * large file neither inflates through JSON nor outruns whatever is draining it.
 */
import { posix, win32 } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  STREAM_WINDOW_BYTES,
  fsReaddirResultSchema,
  fsResolveResultSchema,
  pathStatSchema
} from "@onshell/agent-protocol";
import { FileOperationError, type FileTransport, type PathStat, type RemoteFileEntry } from "../protocols/sftp.js";
import { AgentFileError, AgentUnavailableError, getDevice, type AgentDevice } from "./registry.js";

/** HTTP status for each code an agent can report. */
const FILE_ERROR_STATUS: Record<string, number> = {
  path_not_found: 404,
  permission_denied: 403,
  path_exists: 409,
  directory_not_empty: 409,
  not_a_directory: 400,
  path_is_a_directory: 400,
  path_escapes_session_root: 400,
  channel_in_use: 409,
  too_many_streams: 429,
  agent_offline: 502,
  agent_disconnected: 502,
  rpc_timed_out: 504
};

function toFileError(error: unknown): FileOperationError {
  if (error instanceof FileOperationError) return error;
  if (error instanceof AgentFileError || error instanceof AgentUnavailableError) {
    return new FileOperationError(error.code, FILE_ERROR_STATUS[error.code] ?? 500, error.message);
  }

  return new FileOperationError(
    "file_operation_failed",
    500,
    error instanceof Error ? error.message : undefined
  );
}

async function call<T>(device: AgentDevice, method: string, params: unknown, parse: (value: unknown) => T): Promise<T> {
  try {
    return parse(await device.rpc(method, params));
  } catch (error) {
    throw toFileError(error);
  }
}

/**
 * Reads a file from the agent.
 *
 * Credit is released in `_read`, which Node calls only when the consumer wants
 * more — so the window naturally tracks how fast the *destination* is draining,
 * whether that is a browser download or another host being copied to.
 */
class AgentReadable extends Readable {
  private channelId?: number;
  private owed = 0;
  private finished = false;

  constructor(
    private readonly device: AgentDevice,
    private readonly path: string
  ) {
    super();

    this.channelId = device.openStream({
      onData: (chunk) => {
        this.owed += chunk.length;
        this.push(chunk);
      },
      onEnd: () => {
        this.finished = true;
        this.release();
        this.push(null);
      },
      onError: (code, message) => {
        this.finished = true;
        this.release();
        this.destroy(toFileError(new AgentFileError(code, message)));
      },
      onCredit: () => undefined
    });

    void this.open();
  }

  private async open() {
    try {
      await this.device.rpc("fs.openRead", { path: this.path, ch: this.channelId });
    } catch (error) {
      this.finished = true;
      this.release();
      this.destroy(toFileError(error));
    }
  }

  private release() {
    if (this.channelId === undefined) return;
    this.device.releaseStream(this.channelId);
    this.channelId = undefined;
  }

  _read() {
    if (this.owed === 0 || this.channelId === undefined) return;
    this.device.sendStreamCredit(this.channelId, this.owed);
    this.owed = 0;
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    // A consumer that gave up (a cancelled download) has to tell the agent, or
    // it keeps reading a file nobody is listening to.
    if (!this.finished && this.channelId !== undefined) {
      this.device.sendStreamEnd(this.channelId);
      this.release();
    }
    callback(error);
  }
}

/**
 * Writes a file on the agent.
 *
 * `_final` waits for the agent's own `stream-end`, which it sends only after the
 * data is flushed and the handle closed — so a completed upload means the bytes
 * are on that machine's disk, not merely on the wire.
 */
class AgentWritable extends Writable {
  private channelId?: number;
  private credit = STREAM_WINDOW_BYTES;
  private waiting?: () => void;
  private ready: Promise<void>;
  private done?: () => void;
  private failure?: Error;

  constructor(
    private readonly device: AgentDevice,
    private readonly path: string
  ) {
    super();

    this.channelId = device.openStream({
      onData: () => undefined,
      onEnd: () => {
        this.release();
        this.done?.();
      },
      onError: (code, message) => {
        this.failure = toFileError(new AgentFileError(code, message));
        this.release();
        // Whichever of the two is waiting: an in-flight chunk, or the final
        // flush. Both check `failure` before continuing.
        this.waiting?.();
        this.done?.();
        this.destroy(this.failure);
      },
      onCredit: (bytes) => {
        this.credit += bytes;
        if (this.credit > 0) {
          const release = this.waiting;
          this.waiting = undefined;
          release?.();
        }
      }
    });

    this.ready = this.device.rpc("fs.openWrite", { path: this.path, ch: this.channelId }).then(
      () => undefined,
      (error: unknown) => {
        this.failure = toFileError(error);
        this.release();
        throw this.failure;
      }
    );
    // The rejection is surfaced through `_write`; without this the unhandled
    // rejection would take the gateway down before the caller ever saw it.
    this.ready.catch(() => undefined);
  }

  private release() {
    if (this.channelId === undefined) return;
    this.device.releaseStream(this.channelId);
    this.channelId = undefined;
  }

  async _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;

    try {
      await this.ready;
      if (this.failure) throw this.failure;

      // Out of window: hold this chunk until the agent says it has drained.
      if (this.credit <= 0) {
        await new Promise<void>((resolveWait) => {
          this.waiting = resolveWait;
        });
        if (this.failure) throw this.failure;
      }

      if (this.channelId === undefined) throw new FileOperationError("agent_disconnected", 502);

      this.credit -= buffer.length;
      this.device.sendStreamData(this.channelId, buffer);
      callback();
    } catch (error) {
      callback(toFileError(error));
    }
  }

  async _final(callback: (error?: Error | null) => void) {
    try {
      await this.ready;
      if (this.failure) throw this.failure;
      if (this.channelId === undefined) throw new FileOperationError("agent_disconnected", 502);

      const channelId = this.channelId;
      await new Promise<void>((resolveDone) => {
        this.done = resolveDone;
        this.device.sendStreamEnd(channelId);
      });

      if (this.failure) throw this.failure;
      callback();
    } catch (error) {
      callback(toFileError(error));
    }
  }
}

/**
 * The filesystem of one enrolled machine.
 *
 * `startPath` is the session's start directory; the agent resolves relative
 * paths against it, and absolute ones as given.
 */
export function createAgentTransport(deviceId: string, startPath?: string): FileTransport {
  const device = getDevice(deviceId);
  if (!device?.online) throw new AgentUnavailableError("agent_offline");

  // Path *syntax* is decided here from what the machine told us in `hello`;
  // path *semantics* stay on the agent, which is the side that can actually
  // see the filesystem.
  const paths = device.info.platform === "win32" ? win32 : posix;

  return {
    // Every session to the same machine shares this, which is what lets a copy
    // notice a directory being pasted into its own subtree even when the two
    // panes are two different sessions.
    filesystemKey: `agent:${deviceId}`,

    resolve: (requested) =>
      call(device, "fs.resolve", { requested, startPath }, (value) => fsResolveResultSchema.parse(value).path),

    join: (directory, name) => paths.join(directory, name),
    basename: (path) => paths.basename(path),

    stat: (path) => call(device, "fs.stat", { path }, (value) => pathStatSchema.parse(value) as PathStat),
    lstat: (path) => call(device, "fs.lstat", { path }, (value) => pathStatSchema.parse(value) as PathStat),

    readdir: (path) =>
      call(device, "fs.readdir", { path }, (value) => fsReaddirResultSchema.parse(value).entries as RemoteFileEntry[]),

    mkdir: (path) => call(device, "fs.mkdir", { path }, () => undefined),
    rename: (from, to) => call(device, "fs.rename", { from, to }, () => undefined),
    unlink: (path) => call(device, "fs.unlink", { path }, () => undefined),
    rmdir: (path) => call(device, "fs.rmdir", { path }, () => undefined),

    createReadStream: (path) => new AgentReadable(device, path),
    createWriteStream: (path) => new AgentWritable(device, path),

    // Nothing is held open between operations: each stream owns its own channel
    // and releases it when it ends.
    close: () => undefined
  };
}
