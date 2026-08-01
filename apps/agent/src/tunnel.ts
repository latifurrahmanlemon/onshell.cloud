/**
 * The persistent connection from this machine to the gateway.
 *
 * The agent always dials *out*. That single decision is what makes the product
 * work on a home laptop behind NAT, on hotel wifi, and inside a corporate
 * network that allows nothing inbound — which is to say, everywhere. It also
 * means the customer never opens a port, so there is no listening surface on
 * their machine for anyone else to find.
 */
import { hostname, platform, release } from "node:os";
import WebSocket, { type RawData } from "ws";
import {
  AGENT_PROTOCOL_VERSION,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CONTROL_FRAME_BYTES,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MIN_DELAY_MS,
  decodeDataFrame,
  encodeDataFrame,
  gatewayFrameSchema,
  localExpectParamsSchema,
  parseFrame,
  serializeFrame,
  sessionOpenParamsSchema,
  type AgentFrame
} from "@onshell/agent-protocol";
import { recordAudit } from "./audit.js";
import { AuthError, getConnectionToken } from "./auth.js";
import { notifySessionStarted, requestConsent } from "./consent.js";
import { ChannelError, ChannelManager } from "./channels.js";
import { AGENT_VERSION, type AgentConfig } from "./config.js";
import { FileError, FileService } from "./files.js";
import { LocalServer, type LocalTicket } from "./local-server.js";
import { ptyStatus, spawnPty } from "./pty.js";
import { defaultCwd, machineArch, resolveShell, toDescriptors, type ResolvedShell } from "./shells.js";

function log(message: string, detail?: Record<string, unknown>) {
  const suffix = detail && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : "";
  console.log(`[onshell-agent] ${message}${suffix}`);
}

function agentPlatform(): "win32" | "darwin" | "linux" {
  const current = platform();
  if (current === "win32" || current === "darwin") return current;
  // Everything else (freebsd, aix, …) is close enough to linux for the shell
  // discovery this build does, and the label is only ever informational.
  return "linux";
}

/** `ws` hands back whichever of its three shapes was cheapest to produce. */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(new Uint8Array(data as ArrayBuffer));
}

/**
 * Builds the tunnel URL from the configured gateway base.
 *
 * Appended to the base *path*, not resolved against it. The gateway is not its
 * own host: the deployment puts it behind a path prefix
 * (`https://onshell.cloud/gateway`), and `new URL("/ws/agent", base)` would
 * silently drop that prefix and dial a URL that does not exist.
 */
function websocketUrl(gatewayBaseUrl: string) {
  const url = new URL(`${gatewayBaseUrl.replace(/\/+$/, "")}/ws/agent`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class AgentTunnel {
  private socket?: WebSocket;
  private readonly channels: ChannelManager;
  private readonly files: FileService;
  private readonly local: LocalServer;
  private attempts = 0;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private livenessTimer?: NodeJS.Timeout;
  private lastMessageAt = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly shells: ResolvedShell[]
  ) {
    this.channels = new ChannelManager(
      shells,
      {
        sendData: (channelId, chunk) => this.sendBinary(encodeDataFrame(channelId, chunk)),
        sendExit: (channelId, code) => this.send({ t: "exit", ch: channelId, code })
      },
      log
    );

    this.local = new LocalServer(
      config.deviceId ?? "unknown",
      AGENT_VERSION,
      shells,
      { attach: (socket, ticket) => this.attachLocalTerminal(socket, ticket) },
      log
    );

    this.files = new FileService({
      sendData: (channelId, chunk) => this.sendBinary(encodeDataFrame(channelId, chunk)),
      sendEnd: (channelId) => this.send({ t: "stream-end", ch: channelId }),
      sendError: (channelId, code, message) => this.send({ t: "stream-error", ch: channelId, code, message }),
      sendCredit: (channelId, bytes) => this.send({ t: "stream-credit", ch: channelId, bytes })
    });
  }

  async start() {
    this.stopped = false;
    // Started before connecting so the port can be advertised in `hello`.
    // Failure is expected on plenty of machines and is not worth reporting
    // twice — the listener says so once and the tunnel carries on regardless.
    await this.local.start();
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.channels.closeAll();
    this.files.abortAll();
    this.local.stop();
    this.socket?.close(1000, "agent shutting down");
  }

  private async connect() {
    if (this.stopped) return;

    let token: string;
    try {
      token = await getConnectionToken(this.config);
    } catch (error) {
      const detail = error instanceof AuthError ? `${error.code}: ${error.message}` : String(error);
      log(`authentication failed — ${detail}`);
      this.scheduleReconnect();
      return;
    }

    const url = websocketUrl(this.config.gatewayBaseUrl);
    log("connecting", { url });

    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": `onshell-agent/${AGENT_VERSION}`
      },
      // Frames larger than this are a bug or an attack; refuse them at the
      // socket rather than allocating for them.
      maxPayload: MAX_CONTROL_FRAME_BYTES
    });
    this.socket = socket;

    socket.on("open", () => {
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      this.startLivenessCheck();

      const { available, error } = ptyStatus();
      this.send({
        t: "hello",
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentVersion: AGENT_VERSION,
        platform: agentPlatform(),
        arch: machineArch(),
        osVersion: release(),
        hostname: hostname(),
        shells: toDescriptors(this.shells),
        localPort: this.local.port,
        // Nothing has spawned yet on a fresh process, so assume a pty until
        // proven otherwise; a failed load is reported per channel in `opened`.
        pty: error === undefined || available
      });

      log("connected", { shells: this.shells.map((shell) => shell.token).join(", ") });
    });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      this.lastMessageAt = Date.now();
      const buffer = toBuffer(data);
      if (isBinary) {
        this.handleBinary(buffer);
        return;
      }
      void this.handleControl(buffer.toString("utf8"));
    });

    socket.on("close", (code, reason) => {
      this.onDisconnected(`closed (${code}${reason.length > 0 ? `: ${reason.toString()}` : ""})`);
    });

    socket.on("error", (error) => {
      // 'error' is always followed by 'close', so reconnection is scheduled
      // there — logging both would double every backoff message.
      log(`connection error — ${error.message}`);
    });
  }

  private onDisconnected(reason: string) {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.socket = undefined;

    // Terminals are kept alive for the grace window rather than killed: the
    // user did not ask to end their work, the network did. File streams are
    // not — a half-written file cannot be resumed from a byte offset nobody
    // recorded, so they fail now rather than silently truncating.
    this.channels.detachAll();
    this.files.abortAll();
    log(`disconnected — ${reason}`);
    this.scheduleReconnect();
  }

  /**
   * Detects a connection that is open at the socket level but dead in practice
   * — the classic silently-dropped NAT mapping, where writes succeed into a
   * void. The gateway pings every 30s, so prolonged silence means gone.
   */
  private startLivenessCheck() {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt <= HEARTBEAT_TIMEOUT_MS) return;
      log("no traffic from gateway — dropping connection");
      // terminate(), not close(): a half-open socket will never complete a
      // closing handshake, and waiting for one is how agents get stuck.
      this.socket?.terminate();
    }, HEARTBEAT_TIMEOUT_MS / 3);
    this.livenessTimer.unref?.();
  }

  /**
   * Exponential backoff with full jitter.
   *
   * The jitter is not politeness. When a gateway restarts, every agent it was
   * serving reconnects at once; without randomised delays they stay
   * synchronised and hammer it in waves at each backoff boundary, turning one
   * restart into a rolling outage.
   */
  private scheduleReconnect() {
    if (this.stopped) return;

    const ceiling = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_MIN_DELAY_MS * 2 ** this.attempts);
    const delay = Math.round(RECONNECT_MIN_DELAY_MS + Math.random() * (ceiling - RECONNECT_MIN_DELAY_MS));
    this.attempts += 1;

    log("reconnecting", { inMs: delay });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private async handleControl(raw: string) {
    const frame = parseFrame(gatewayFrameSchema, raw);
    if (!frame) {
      // Unparseable input from the gateway is either a version mismatch or
      // something hostile. Neither is worth staying connected for.
      log("received a malformed frame — dropping connection");
      this.socket?.close(1008, "malformed frame");
      return;
    }

    switch (frame.t) {
      case "ping":
        this.send({ t: "pong" });
        return;

      case "open-shell": {
        try {
          const opened = await this.channels.open({
            channelId: frame.ch,
            shell: frame.shell,
            cols: frame.cols,
            rows: frame.rows,
            cwd: frame.cwd
          });
          this.send({ t: "opened", ch: frame.ch, pid: opened.pid, resumed: opened.resumed, pty: opened.pty });
          if (!opened.resumed) {
            void recordAudit("terminal.opened", { shell: frame.shell, pid: opened.pid });
          }
        } catch (error) {
          const code = error instanceof ChannelError ? error.code : "spawn_failed";
          const message = error instanceof Error ? error.message : String(error);
          log(`could not open terminal — ${code}: ${message}`, { channelId: frame.ch });
          this.send({ t: "channel-error", ch: frame.ch, code, message });
        }
        return;
      }

      case "resize":
        this.channels.resize(frame.ch, frame.cols, frame.rows);
        return;

      case "close":
        this.channels.close(frame.ch);
        void recordAudit("terminal.closed", { channel: frame.ch });
        return;

      case "kill":
        log(`gateway ended this connection — ${frame.reason}`);
        this.channels.closeAll();
        this.files.abortAll();
        this.socket?.close(1000, "killed by gateway");
        return;

      case "rpc": {
        try {
          const result =
            frame.method === "session.open"
              ? await this.authorizeSession(frame.params)
              : frame.method === "local.expect"
                ? this.expectLocal(frame.params)
                : await this.files.call(frame.method, frame.params);
          this.send({ t: "rpc-ok", id: frame.id, result });
        } catch (error) {
          const code = error instanceof FileError ? error.code : "file_operation_failed";
          const message = error instanceof Error ? error.message : String(error);
          this.send({ t: "rpc-err", id: frame.id, code, message });
        }
        return;
      }

      case "stream-end":
        this.files.end(frame.ch);
        return;

      case "stream-error":
        this.files.abort(frame.ch);
        return;

      case "stream-credit":
        this.files.credit(frame.ch, frame.bytes);
        return;
    }
  }

  /**
   * The gateway asking whether a session may start on this machine.
   *
   * This is the last point at which the person who owns the computer gets a
   * say, so nothing is started before it answers — no shell is spawned, no file
   * handle opened. A denial is an rpc error the console renders as a refusal
   * rather than a failure.
   */
  /** The gateway telling us a browser on this machine is about to connect. */
  private expectLocal(params: unknown) {
    const input = localExpectParamsSchema.parse(params);
    this.local.expect(input.ticket, { shell: input.shell, cwd: input.cwd, expiresInMs: input.expiresInMs });
    return { ok: true as const };
  }

  private async authorizeSession(params: unknown) {
    const input = sessionOpenParamsSchema.parse(params);
    const request = {
      kind: input.kind,
      requestedBy: input.requestedBy,
      ownerUserId: this.config.ownerUserId,
      mode: this.config.approval
    };

    await recordAudit("session.requested", {
      kind: input.kind,
      by: input.requestedBy?.email,
      byId: input.requestedBy?.id,
      mode: this.config.approval
    });

    const decision = await requestConsent(request);
    await recordAudit(decision.granted ? "session.granted" : "session.denied", {
      kind: input.kind,
      by: input.requestedBy?.email,
      reason: decision.reason
    });

    if (!decision.granted) {
      log(`refused a ${input.kind} session for ${input.requestedBy?.email ?? "an unknown user"}`);
      throw new FileError("consent_denied", "The person at this computer did not allow the session.");
    }

    // Only when it was *not* asked for: a dialog somebody just clicked through
    // does not also need a notification telling them what they clicked.
    if (decision.reason !== "approved_locally") notifySessionStarted(request);
    log(`allowed a ${input.kind} session for ${input.requestedBy?.email ?? "an unknown user"} (${decision.reason})`);

    return { granted: true as const };
  }

  /**
   * A browser on this machine, connected straight to us.
   *
   * Speaks the same frames the gateway's terminal WebSocket does, so the web
   * terminal component does not know or care which route it got. Consent has
   * already happened: a ticket only exists because `session.open` was allowed.
   */
  private async attachLocalTerminal(socket: WebSocket, ticket: LocalTicket) {
    const shell =
      (ticket.shell ? resolveShell(this.shells, ticket.shell) : undefined) ??
      this.shells.find((candidate) => candidate.default) ??
      this.shells[0];
    if (!shell) {
      socket.close(1011, "No shell available");
      return;
    }

    const pty = await spawnPty(shell, { cols: 80, rows: 24, cwd: ticket.cwd ?? defaultCwd() });
    void recordAudit("terminal.opened", { shell: shell.token, pid: pty.pid, local: true });
    log("loopback terminal opened", { shell: shell.token, pid: pty.pid });

    socket.send(
      JSON.stringify({
        type: "system",
        data: pty.pty
          ? "Connected to your machine (direct)."
          : "Connected to your machine (direct, no pty — job control and resize are disabled)."
      })
    );

    pty.onData((chunk) => {
      if (socket.readyState === socket.OPEN) socket.send(chunk.toString("utf8"));
    });
    pty.onExit(() => {
      if (socket.readyState === socket.OPEN) socket.close(1000, "Shell closed");
    });

    socket.on("message", (message: RawData) => {
      const text = toBuffer(message).toString("utf8");
      if (text.startsWith("{")) {
        try {
          const frame = JSON.parse(text) as { type?: string; cols?: number; rows?: number; data?: string };
          if (frame.type === "resize" && typeof frame.cols === "number" && typeof frame.rows === "number") {
            pty.resize(frame.cols, frame.rows);
            return;
          }
          if (frame.type === "data" && typeof frame.data === "string") {
            pty.write(frame.data);
            return;
          }
        } catch {
          // Not a control frame — raw keyboard input.
        }
      }

      pty.write(text);
    });

    socket.on("close", () => {
      pty.kill();
      void recordAudit("terminal.closed", { local: true });
    });
  }

  private handleBinary(buffer: Buffer) {
    const frame = decodeDataFrame(buffer);
    if (!frame) return;

    // Terminals and file streams share one channel id space, so whoever owns
    // this channel gets the bytes.
    if (this.files.owns(frame.channelId)) {
      this.files.write(frame.channelId, frame.payload);
      return;
    }

    this.channels.write(frame.channelId, frame.payload);
  }

  private send(frame: AgentFrame) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(serializeFrame(frame));
  }

  private sendBinary(frame: Buffer) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(frame, { binary: true });
  }
}
