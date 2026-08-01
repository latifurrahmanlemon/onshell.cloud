/**
 * The set of live terminals on this machine, keyed by the gateway's channel id.
 *
 * The interesting behaviour here is survival across a dropped tunnel. A laptop
 * that changes wifi networks, or a phone that loses signal in a lift, must not
 * kill a running build — so when the connection goes away the ptys are *kept*,
 * their output is buffered, and a reconnect inside the grace window resumes
 * them where they left off. Only after the window closes are they killed.
 */
import {
  CHANNEL_REPLAY_BUFFER_BYTES,
  CHANNEL_RESUME_GRACE_MS,
  MAX_DATA_FRAME_BYTES
} from "@onshell/agent-protocol";
import { spawnPty, type AgentPty } from "./pty.js";
import { defaultCwd, resolveShell, type ResolvedShell } from "./shells.js";

/**
 * Ceiling on concurrent terminals for one agent.
 *
 * A compromised or buggy gateway must not be able to fork-bomb a customer's
 * laptop by asking for channels in a loop. Well above any human's tab count.
 */
export const MAX_CHANNELS = 32;

export class ChannelError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "ChannelError";
  }
}

interface Channel {
  pty: AgentPty;
  shellToken: string;
  /** False while the tunnel is down and this channel is waiting to be resumed. */
  attached: boolean;
  /** Output produced while detached, replayed on resume. */
  replay: Buffer[];
  replayBytes: number;
  graceTimer?: NodeJS.Timeout;
}

export interface ChannelHooks {
  /** Send pty output. Called only while the channel is attached. */
  sendData(channelId: number, chunk: Buffer): void;
  sendExit(channelId: number, code?: number): void;
}

export class ChannelManager {
  private readonly channels = new Map<number, Channel>();

  constructor(
    private readonly shells: ResolvedShell[],
    private readonly hooks: ChannelHooks,
    private readonly log: (message: string, detail?: Record<string, unknown>) => void
  ) {}

  get size() {
    return this.channels.size;
  }

  /**
   * Opens a terminal, or resumes one held from a dropped connection.
   *
   * The gateway reuses a channel id when the session behind it is still alive,
   * so an `open-shell` naming a held channel means "resume", not "start". No
   * separate frame is needed, and an agent that has since restarted simply has
   * nothing held and starts a fresh shell — reporting `resumed: false` so the
   * console can say so instead of silently handing the user a new prompt.
   */
  async open(input: {
    channelId: number;
    shell: string;
    cols: number;
    rows: number;
    cwd?: string;
  }): Promise<{ pid?: number; resumed: boolean; pty: boolean }> {
    const held = this.channels.get(input.channelId);
    if (held) {
      if (held.attached) throw new ChannelError("channel_in_use");
      return this.resume(input.channelId, held, input.cols, input.rows);
    }

    if (this.channels.size >= MAX_CHANNELS) throw new ChannelError("too_many_channels");

    const shell = resolveShell(this.shells, input.shell);
    if (!shell) throw new ChannelError("shell_not_available", `no shell advertised as ${input.shell}`);

    let pty: AgentPty;
    try {
      pty = await spawnPty(shell, {
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd && input.cwd.length > 0 ? input.cwd : defaultCwd()
      });
    } catch (error) {
      throw new ChannelError("spawn_failed", error instanceof Error ? error.message : String(error));
    }

    const channel: Channel = {
      pty,
      shellToken: shell.token,
      attached: true,
      replay: [],
      replayBytes: 0
    };
    this.channels.set(input.channelId, channel);

    pty.onData((chunk) => {
      if (channel.attached) {
        this.hooks.sendData(input.channelId, chunk);
        return;
      }
      this.buffer(channel, chunk);
    });

    pty.onExit((code) => {
      this.forget(input.channelId);
      // A shell that exits while the tunnel is down has nowhere to report to;
      // the gateway learns it is gone when it tries to resume and gets a fresh one.
      if (channel.attached) this.hooks.sendExit(input.channelId, code);
    });

    this.log("terminal opened", { channelId: input.channelId, shell: shell.token, pid: pty.pid });
    return { pid: pty.pid, resumed: false, pty: pty.pty };
  }

  private resume(channelId: number, channel: Channel, cols: number, rows: number) {
    if (channel.graceTimer) {
      clearTimeout(channel.graceTimer);
      channel.graceTimer = undefined;
    }

    channel.attached = true;
    channel.pty.resize(cols, rows);

    const pending = channel.replay;
    channel.replay = [];
    channel.replayBytes = 0;
    for (const chunk of pending) this.hooks.sendData(channelId, chunk);

    this.log("terminal resumed", { channelId, shell: channel.shellToken, replayed: pending.length });
    return { pid: channel.pty.pid, resumed: true, pty: channel.pty.pty };
  }

  /** Ring-buffers detached output, dropping oldest first once over the cap. */
  private buffer(channel: Channel, chunk: Buffer) {
    // A single write larger than the whole buffer would evict everything and
    // still not fit; keep only its tail, which is what a terminal would show.
    const piece = chunk.length > CHANNEL_REPLAY_BUFFER_BYTES ? chunk.subarray(-CHANNEL_REPLAY_BUFFER_BYTES) : chunk;

    channel.replay.push(piece);
    channel.replayBytes += piece.length;

    while (channel.replayBytes > CHANNEL_REPLAY_BUFFER_BYTES && channel.replay.length > 1) {
      const dropped = channel.replay.shift();
      channel.replayBytes -= dropped?.length ?? 0;
    }
  }

  write(channelId: number, payload: Buffer) {
    if (payload.length > MAX_DATA_FRAME_BYTES) return;
    this.channels.get(channelId)?.pty.write(payload);
  }

  resize(channelId: number, cols: number, rows: number) {
    this.channels.get(channelId)?.pty.resize(cols, rows);
  }

  /** Explicit close from the gateway: the user closed the tab, so kill it now. */
  close(channelId: number) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.forget(channelId);
    channel.pty.kill();
    this.log("terminal closed", { channelId });
  }

  /**
   * The tunnel dropped. Hold every pty for the grace period rather than killing
   * work the user did not ask to end.
   */
  detachAll() {
    for (const [channelId, channel] of this.channels) {
      channel.attached = false;
      channel.graceTimer = setTimeout(() => {
        this.log("terminal expired after disconnect", { channelId });
        this.forget(channelId);
        channel.pty.kill();
      }, CHANNEL_RESUME_GRACE_MS);
      // Node would otherwise stay alive purely to fire this timer during shutdown.
      channel.graceTimer.unref?.();
    }
  }

  /** Shutdown, or a `kill` frame: everything goes, immediately. */
  closeAll() {
    for (const channelId of [...this.channels.keys()]) this.close(channelId);
  }

  private forget(channelId: number) {
    const channel = this.channels.get(channelId);
    if (channel?.graceTimer) clearTimeout(channel.graceTimer);
    this.channels.delete(channelId);
  }
}
