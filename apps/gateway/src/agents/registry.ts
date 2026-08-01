/**
 * Agents connected to this gateway.
 *
 * An agent is a program on a customer's own machine that dials out to us and
 * holds the connection open, so a browser anywhere can get a terminal on that
 * machine. See docs/agent.md.
 *
 * The structure worth understanding is the split between a **device** and a
 * **connection**. A device outlives its socket: when a laptop changes wifi
 * networks the tunnel drops and comes back seconds later, and the user's
 * running build must survive that. So terminals hang off the device, not off
 * the socket, and reconnecting re-issues `open-shell` on the same channel ids
 * — which the agent understands as "resume", replaying the output it buffered
 * while away.
 *
 * The registry is in-process, which is correct for one gateway and wrong for
 * several: a browser could land on a node that does not hold the agent's
 * socket. Redis routing is the fix when a second gateway appears; nothing in
 * the frame format has to change for it.
 */
import type { WebSocket } from "ws";
import {
  AGENT_TOKEN_TTL_SECONDS,
  CHANNEL_RESUME_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CONTROL_FRAME_BYTES,
  agentFrameSchema,
  decodeDataFrame,
  encodeDataFrame,
  parseFrame,
  serializeFrame,
  type GatewayFrame,
  type HelloFrame,
  type ShellDescriptor
} from "@onshell/agent-protocol";

/**
 * How long to wait for a shell to start.
 *
 * Generous on purpose: the far end may be a laptop that just woke up, and a
 * cold PowerShell profile can take seconds. Failing early here would look like
 * a broken product on exactly the machines people care about most.
 */
const OPEN_TIMEOUT_MS = 15_000;

/**
 * A terminal on an agent, shaped like the `LocalShell` the SSH WebSocket
 * handler already speaks, so routes.ts does not grow a third branch.
 */
export interface AgentShell {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: () => void): void;
  /** Out-of-band messages for the user: resumed, reconnecting, gave up. */
  onNotice(listener: (text: string) => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  end(): void;
  pty: boolean;
}

/**
 * How long to wait for an `fs.*` reply.
 *
 * Longer than feels necessary because the far end is somebody's laptop: a
 * directory listing on a cold spinning disk, or a network drive that has to
 * wake up, genuinely takes seconds.
 */
const RPC_TIMEOUT_MS = 30_000;

interface PendingOpen {
  resolve: (value: { pid?: number; resumed: boolean; pty: boolean }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** The gateway end of one file stream. */
export interface StreamSink {
  onData(chunk: Buffer): void;
  onEnd(): void;
  onError(code: string, message?: string): void;
  /** Only meaningful while *writing*: the agent has room for more. */
  onCredit(bytes: number): void;
}

export class AgentUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentUnavailableError";
  }
}

/**
 * A file operation the agent refused, carrying the agent's own code
 * (`path_not_found`, `permission_denied`, …) so the file routes can report the
 * same vocabulary they do for SSH and local hosts.
 */
export class AgentFileError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "AgentFileError";
  }
}

class Channel implements AgentShell {
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<() => void> = [];
  private readonly noticeListeners: Array<(text: string) => void> = [];
  private ended = false;

  pty = true;

  constructor(
    readonly channelId: number,
    readonly shellToken: string,
    private cols: number,
    private rows: number,
    readonly cwd: string | undefined,
    private readonly device: AgentDevice
  ) {}

  get size() {
    return { cols: this.cols, rows: this.rows };
  }

  onData(listener: (chunk: string) => void) {
    this.dataListeners.push(listener);
  }

  onExit(listener: () => void) {
    this.exitListeners.push(listener);
  }

  onNotice(listener: (text: string) => void) {
    this.noticeListeners.push(listener);
  }

  write(data: string) {
    this.device.sendBinary(encodeDataFrame(this.channelId, data));
  }

  resize(columns: number, rows: number) {
    this.cols = columns;
    this.rows = rows;
    this.device.send({ t: "resize", ch: this.channelId, cols: columns, rows: rows });
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.device.send({ t: "close", ch: this.channelId });
    this.device.forgetChannel(this.channelId);
  }

  emitData(chunk: Buffer) {
    const text = chunk.toString("utf8");
    for (const listener of this.dataListeners) listener(text);
  }

  emitNotice(text: string) {
    for (const listener of this.noticeListeners) listener(text);
  }

  emitExit() {
    if (this.ended) return;
    this.ended = true;
    for (const listener of this.exitListeners) listener();
  }
}

export class AgentDevice {
  private socket?: WebSocket;
  private hello?: HelloFrame;
  private readonly channels = new Map<number, Channel>();
  private readonly pending = new Map<number, PendingOpen>();
  private readonly streams = new Map<number, StreamSink>();
  private readonly rpcs = new Map<string, PendingRpc>();
  private nextChannelId = 1;
  private nextRpcId = 1;
  private heartbeatTimer?: NodeJS.Timeout;
  private graceTimer?: NodeJS.Timeout;
  private lastMessageAt = 0;

  connectedAt?: string;

  constructor(
    readonly deviceId: string,
    readonly organizationId: string,
    private readonly log: (message: string, detail?: Record<string, unknown>) => void
  ) {}

  get online() {
    return this.socket !== undefined && this.hello !== undefined;
  }

  get shells(): ShellDescriptor[] {
    return this.hello?.shells ?? [];
  }

  get info() {
    return {
      deviceId: this.deviceId,
      organizationId: this.organizationId,
      online: this.online,
      connectedAt: this.connectedAt,
      platform: this.hello?.platform,
      arch: this.hello?.arch,
      osVersion: this.hello?.osVersion,
      hostname: this.hello?.hostname,
      agentVersion: this.hello?.agentVersion,
      shells: this.shells,
      /** Loopback port, when this agent managed to open one. */
      localPort: this.hello?.localPort,
      terminals: this.channels.size
    };
  }

  /* ----------------------------- connection ----------------------------- */

  attach(socket: WebSocket) {
    // A second connection for the same device means the old one is stale (a
    // killed process, a laptop that resumed from sleep before the old socket
    // timed out). The newcomer wins; the stale one is closed rather than left
    // to fight over channel ids.
    if (this.socket) {
      this.log("replacing a stale agent connection", { deviceId: this.deviceId });
      const stale = this.socket;
      this.socket = undefined;
      stale.close(1000, "replaced by a newer connection");
    }

    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }

    this.socket = socket;
    this.lastMessageAt = Date.now();
    this.startHeartbeat();
  }

  detach(socket: WebSocket) {
    // Ignore the close event of a connection we already replaced.
    if (this.socket !== socket) return;

    this.socket = undefined;
    this.hello = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentUnavailableError("agent_disconnected"));
    }
    this.pending.clear();

    for (const rpc of this.rpcs.values()) {
      clearTimeout(rpc.timer);
      rpc.reject(new AgentUnavailableError("agent_disconnected"));
    }
    this.rpcs.clear();

    // Terminals survive a reconnect; file streams cannot. A transfer that was
    // halfway through has no resume point either side recorded, so failing it
    // now is the only honest option — a silently truncated file is worse than
    // an error.
    for (const [channelId, sink] of this.streams) {
      this.streams.delete(channelId);
      sink.onError("agent_disconnected");
    }

    if (this.channels.size === 0) {
      removeDevice(this.deviceId);
      return;
    }

    for (const channel of this.channels.values()) {
      channel.emitNotice("Connection to this machine was lost. Waiting for it to come back…");
    }

    // Mirrors the agent's own grace window. If it has not returned by then, the
    // terminals it was holding are gone, and the browser should be told rather
    // than left staring at a dead prompt.
    this.graceTimer = setTimeout(() => {
      this.log("agent did not return within the grace window", { deviceId: this.deviceId });
      for (const channel of [...this.channels.values()]) {
        channel.emitNotice("This machine did not reconnect. The session has ended.");
        channel.emitExit();
      }
      this.channels.clear();
      removeDevice(this.deviceId);
    }, CHANNEL_RESUME_GRACE_MS);
    this.graceTimer.unref?.();
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
        this.log("agent stopped answering — dropping connection", { deviceId: this.deviceId });
        // terminate(), not close(): a half-open socket never completes a
        // closing handshake, and waiting for one is how connections leak.
        this.socket?.terminate();
        return;
      }
      this.send({ t: "ping" });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  /* ------------------------------- frames ------------------------------- */

  handleMessage(raw: Buffer, isBinary: boolean) {
    this.lastMessageAt = Date.now();

    if (isBinary) {
      const frame = decodeDataFrame(raw);
      if (!frame) return;

      // Terminals and file streams share one channel id space.
      const stream = this.streams.get(frame.channelId);
      if (stream) {
        stream.onData(frame.payload);
        return;
      }

      this.channels.get(frame.channelId)?.emitData(frame.payload);
      return;
    }

    if (raw.length > MAX_CONTROL_FRAME_BYTES) {
      this.socket?.close(1009, "control frame too large");
      return;
    }

    const frame = parseFrame(agentFrameSchema, raw.toString("utf8"));
    if (!frame) {
      this.log("malformed frame from agent", { deviceId: this.deviceId });
      this.socket?.close(1008, "malformed frame");
      return;
    }

    switch (frame.t) {
      case "hello": {
        this.hello = frame;
        this.connectedAt = new Date().toISOString();
        this.log("agent online", {
          deviceId: this.deviceId,
          platform: frame.platform,
          agentVersion: frame.agentVersion,
          shells: frame.shells.length
        });
        // Anything held from a previous socket is resumed now, before the
        // browser notices anything happened.
        this.resumeChannels();
        return;
      }

      case "opened": {
        const pending = this.pending.get(frame.ch);
        const channel = this.channels.get(frame.ch);
        if (channel) channel.pty = frame.pty;

        if (!pending) {
          // No waiter means this answered a resume rather than a fresh open.
          if (channel) {
            channel.emitNotice(
              frame.resumed
                ? "Reconnected to this machine — your session is intact."
                : "Reconnected to this machine, but the previous shell was gone. Started a new one."
            );
          }
          return;
        }

        clearTimeout(pending.timer);
        this.pending.delete(frame.ch);
        pending.resolve({ pid: frame.pid, resumed: frame.resumed, pty: frame.pty });
        return;
      }

      case "channel-error": {
        const pending = this.pending.get(frame.ch);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(frame.ch);
          pending.reject(new AgentUnavailableError(frame.code));
        }
        const channel = this.channels.get(frame.ch);
        if (channel) {
          channel.emitNotice(`This machine could not start the terminal (${frame.code}).`);
          channel.emitExit();
          this.channels.delete(frame.ch);
        }
        return;
      }

      case "exit": {
        const channel = this.channels.get(frame.ch);
        this.channels.delete(frame.ch);
        channel?.emitExit();
        return;
      }

      case "pong":
        return;

      case "rpc-ok": {
        const rpc = this.rpcs.get(frame.id);
        if (!rpc) return;
        clearTimeout(rpc.timer);
        this.rpcs.delete(frame.id);
        rpc.resolve(frame.result);
        return;
      }

      case "rpc-err": {
        const rpc = this.rpcs.get(frame.id);
        if (!rpc) return;
        clearTimeout(rpc.timer);
        this.rpcs.delete(frame.id);
        rpc.reject(new AgentFileError(frame.code, frame.message));
        return;
      }

      case "stream-end": {
        const stream = this.streams.get(frame.ch);
        // Left registered on purpose for a write: the sink resolves its own
        // completion and releases the channel, so a late duplicate frame has
        // nothing to corrupt.
        stream?.onEnd();
        return;
      }

      case "stream-error": {
        const stream = this.streams.get(frame.ch);
        this.streams.delete(frame.ch);
        stream?.onError(frame.code, frame.message);
        return;
      }

      case "stream-credit":
        this.streams.get(frame.ch)?.onCredit(frame.bytes);
        return;
    }
  }

  /* --------------------------------- rpc --------------------------------- */

  /** Calls one `fs.*` method on the agent and waits for its reply. */
  rpc(method: string, params?: unknown): Promise<unknown> {
    if (!this.online) return Promise.reject(new AgentUnavailableError("agent_offline"));

    const id = `r${this.nextRpcId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcs.delete(id);
        reject(new AgentUnavailableError("rpc_timed_out"));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();

      this.rpcs.set(id, { resolve, reject, timer });
      this.send({ t: "rpc", id, method, params });
    });
  }

  /* -------------------------------- streams ------------------------------- */

  /** Reserves a channel for a file stream and routes its frames to `sink`. */
  openStream(sink: StreamSink) {
    const channelId = this.allocateChannelId();
    this.streams.set(channelId, sink);
    return channelId;
  }

  releaseStream(channelId: number) {
    this.streams.delete(channelId);
  }

  sendStreamData(channelId: number, chunk: Buffer) {
    this.sendBinary(encodeDataFrame(channelId, chunk));
  }

  sendStreamEnd(channelId: number) {
    this.send({ t: "stream-end", ch: channelId });
  }

  sendStreamCredit(channelId: number, bytes: number) {
    this.send({ t: "stream-credit", ch: channelId, bytes });
  }

  sendStreamError(channelId: number, code: string) {
    this.send({ t: "stream-error", ch: channelId, code });
  }

  send(frame: GatewayFrame) {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(serializeFrame(frame));
  }

  sendBinary(frame: Buffer) {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(frame, { binary: true });
  }

  /* ------------------------------ terminals ----------------------------- */

  /**
   * Opens a terminal and waits for the agent to confirm it started.
   *
   * The channel is registered before the frame goes out so that output arriving
   * in the same tick as `opened` is not dropped on the floor.
   */
  async openShell(input: { shell?: string; cols: number; rows: number; cwd?: string }): Promise<AgentShell> {
    if (!this.online) throw new AgentUnavailableError("agent_offline");

    const shell = input.shell ?? this.defaultShell();
    if (!shell) throw new AgentUnavailableError("no_shell_available");
    if (!this.shells.some((descriptor) => descriptor.token === shell)) {
      throw new AgentUnavailableError("shell_not_available");
    }

    const channelId = this.allocateChannelId();
    const channel = new Channel(channelId, shell, input.cols, input.rows, input.cwd, this);
    this.channels.set(channelId, channel);

    try {
      const opened = await new Promise<{ pid?: number; resumed: boolean; pty: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(channelId);
          reject(new AgentUnavailableError("open_timed_out"));
        }, OPEN_TIMEOUT_MS);
        timer.unref?.();

        this.pending.set(channelId, { resolve, reject, timer });
        this.send({ t: "open-shell", ch: channelId, shell, cols: input.cols, rows: input.rows, cwd: input.cwd });
      });

      channel.pty = opened.pty;
      this.log("terminal opened on agent", { deviceId: this.deviceId, channelId, shell, pid: opened.pid });
      return channel;
    } catch (error) {
      this.channels.delete(channelId);
      throw error;
    }
  }

  private defaultShell() {
    return (this.shells.find((shell) => shell.default) ?? this.shells[0])?.token;
  }

  /**
   * Channel ids must not be reused while a terminal still holds one, since the
   * agent treats a known id as a resume request. Wrapping at 32 bits and
   * skipping live ids keeps that true for any realistic uptime.
   */
  private allocateChannelId() {
    for (let attempt = 0; attempt < 0xffff; attempt += 1) {
      const candidate = this.nextChannelId;
      this.nextChannelId = this.nextChannelId >= 0xffff_ffff ? 1 : this.nextChannelId + 1;
      if (!this.channels.has(candidate) && !this.pending.has(candidate) && !this.streams.has(candidate)) {
        return candidate;
      }
    }

    throw new AgentUnavailableError("no_channel_available");
  }

  /** Re-issues every live terminal on a freshly attached socket. */
  private resumeChannels() {
    for (const channel of this.channels.values()) {
      const { cols, rows } = channel.size;
      this.send({ t: "open-shell", ch: channel.channelId, shell: channel.shellToken, cols, rows, cwd: channel.cwd });
    }
  }

  forgetChannel(channelId: number) {
    this.channels.delete(channelId);
  }

  /** Revocation, or shutdown: end everything now and tell the agent why. */
  kill(reason: string) {
    this.send({ t: "kill", reason });
    for (const channel of [...this.channels.values()]) {
      channel.emitNotice(`Session ended: ${reason}`);
      channel.emitExit();
    }
    this.channels.clear();
    this.socket?.close(1000, reason);
    removeDevice(this.deviceId);
  }
}

/* ------------------------------- registry -------------------------------- */

const devices = new Map<string, AgentDevice>();

/**
 * Devices refused reconnection, with the moment they stop being refused.
 *
 * Revocation happens in the API's database, which the gateway cannot read. It
 * authenticates agents purely by verifying a signature, so a token minted a
 * minute before a device was revoked still verifies here for the rest of its
 * fifteen minutes — long enough for a machine that just lost access to
 * reconnect and keep working.
 *
 * Holding the id for one token lifetime closes that window. It is deliberately
 * in-memory and short-lived: this is not the authority on revocation, just a
 * stop-gap for tokens already in flight. The database says no on the next
 * refresh regardless, and a gateway restart inside the window is no worse than
 * not having this at all.
 */
const denied = new Map<string, number>();

export function denyDevice(deviceId: string, ttlMs = AGENT_TOKEN_TTL_SECONDS * 1000) {
  denied.set(deviceId, Date.now() + ttlMs);
}

/** Lifts a denial early, for a device that has just been paired again. */
export function allowDevice(deviceId: string) {
  denied.delete(deviceId);
}

export function isDeviceDenied(deviceId: string) {
  const until = denied.get(deviceId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;

  denied.delete(deviceId);
  return false;
}

export function getOrCreateDevice(
  deviceId: string,
  organizationId: string,
  log: (message: string, detail?: Record<string, unknown>) => void
) {
  const existing = devices.get(deviceId);
  // The organization is read from a signed token, so a mismatch means either a
  // device that was moved between organizations or a forged claim. Either way
  // the old entry is not the one being asked for.
  if (existing && existing.organizationId === organizationId) return existing;
  if (existing) existing.kill("device re-registered under a different organization");

  const device = new AgentDevice(deviceId, organizationId, log);
  devices.set(deviceId, device);
  return device;
}

export function getDevice(deviceId: string) {
  return devices.get(deviceId);
}

export function removeDevice(deviceId: string) {
  devices.delete(deviceId);
}

export function listDevices() {
  return [...devices.values()].map((device) => device.info);
}
