/**
 * Gateway wire protocol
 * =====================
 *
 * REST (called by the API service, never by browsers):
 *   - GET    /health                          liveness probe (never requires auth)
 *   - POST   /sessions                        open a session (body: openSessionSchema below)
 *   - GET    /sessions                        list gateway sessions
 *   - GET    /sessions/:sessionId             inspect one gateway session
 *   - POST   /sessions/:sessionId/close       terminate a gateway session
 *   File operations on an open sftp session (both transports, see below):
 *   - GET    /sessions/:sessionId/sftp/list   list a directory (?path=.)
 *   - GET    /sessions/:sessionId/sftp/read   read a text file (?path=)
 *   - PUT    /sessions/:sessionId/sftp/write  write a text file ({path, content})
 *   - POST   /sessions/:sessionId/sftp/mkdir  create one directory ({path})
 *   - POST   /sessions/:sessionId/sftp/rename rename or move ({from, to})
 *   - DELETE /sessions/:sessionId/sftp/remove delete (?path=&recursive=true|false)
 *   - POST   /sessions/:sessionId/sftp/copy   copy into another open session
 *                                             ({path, toSessionId, toPath})
 *   Mutations answer `{ ok: true, ... }`; reads answer the payload directly.
 *   Failures answer `{ error: "<code>", message }` — `path_not_found`,
 *   `permission_denied`, `path_exists`, `file_too_large`, `recursive_required`,
 *   `path_escapes_session_root`, … — with a status the API forwards for 4xx.
 *   When the GATEWAY_SHARED_SECRET environment variable is set, every REST
 *   endpoint except /health requires `Authorization: Bearer <secret>`.
 *
 *   POST /sessions accepts `transport: "local"`, which serves the shell and the
 *   file operations from this machine instead of dialling out over SSH — the
 *   built-in host every workspace gets. See protocols/local.ts. Every file
 *   operation above works on either transport, and copy works between them in
 *   both directions: the two sessions share this process, so the bytes are piped
 *   from one session straight into the other rather than through the API.
 *
 *   It also accepts `transport: "agent"` with a `deviceId`, which serves the
 *   shell from a *customer's own machine* over the tunnel that machine holds
 *   open to us. See protocols/agent.ts and docs/agent.md.
 *   - GET    /agents                          list agents connected to this node
 *
 * WebSocket /ws/agent (the agent itself, never a browser):
 *   Authenticated with `Authorization: Bearer <agent JWT>`, minted by the API
 *   from the device's long-lived token. Frames are the protocol in
 *   packages/agent-protocol: JSON text for control, binary for pty bytes.
 *
 * WebSocket /ws/ssh/:sessionId (browser terminal, e.g. xterm.js):
 *   server -> client:
 *     - UTF-8 text frames containing raw terminal output (stdout/stderr).
 *     - The first frame is a JSON control frame {"type":"system","data":"..."}.
 *   client -> server:
 *     - Control frames are JSON text starting with "{" and carrying a known type:
 *         {"type":"resize","cols":<number>,"rows":<number>}  resize the remote pty
 *         {"type":"data","data":"<text>"}                    explicit keyboard input
 *     - Any other frame (including JSON with an unknown type) is written
 *       verbatim to the shell as keyboard input.
 *
 * WebSocket /ws/rdp/:sessionId:
 *   Opaque bidirectional relay of the Guacamole protocol between the browser
 *   client (guacamole-common-js) and guacd. Frames pass through untouched.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { requesterSchema, verifyAgentToken } from "@onshell/agent-protocol";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import {
  AgentUnavailableError,
  allowDevice,
  denyDevice,
  getDevice,
  getOrCreateDevice,
  isDeviceDenied,
  listDevices
} from "./agents/registry.js";
import { createAgentTransport } from "./agents/file-transport.js";
import { closeAgentShell, openAgentFileSession, openAgentSession, openAgentShell } from "./protocols/agent.js";
import {
  closeLocalShell,
  createLocalTransport,
  openLocalFileSession,
  openLocalSession,
  openLocalShell
} from "./protocols/local.js";
import { openRdpSession } from "./protocols/rdp.js";
import {
  FileOperationError,
  MAX_TEXT_FILE_BYTES,
  copyPath,
  createSftpTransport,
  listDirectory,
  makeDirectory,
  openSftpSession,
  readTextFile,
  removePath,
  renamePath,
  writeTextFile,
  type FileTransport
} from "./protocols/sftp.js";
import { createGuacdTunnel } from "./protocols/rdp-connections.js";
import { closeSshClient, openShell, SshConnectionError } from "./protocols/ssh-connections.js";
import { openSshSession } from "./protocols/ssh.js";
import { getGatewaySession, listGatewaySessions, updateGatewaySession, type GatewaySession } from "./registry.js";

/** Local sessions are tagged at creation; everything else dials out over SSH. */
function isLocalSession(session: GatewaySession) {
  return session.metadata?.transport === "local";
}

/** Agent sessions reach a customer's machine through its own outbound tunnel. */
function isAgentSession(session: GatewaySession) {
  return session.metadata?.transport === "agent";
}

const openSessionSchema = z
  .object({
    protocol: z.enum(["ssh", "sftp", "rdp"]),
    hostId: z.string(),
    address: z.string(),
    /**
     * Zero is allowed because it is what a host that is never dialled stores:
     * the local transport spawns a shell in this process, and an agent host is
     * already connected to us. `superRefine` below still demands a real port
     * from anything that opens a socket.
     */
    port: z.number().int().min(0).max(65535),
    /**
     * "local" runs the shell and the file listing in this process instead of
     * dialling out — the built-in host every workspace gets. "agent" reaches a
     * customer's own machine through the tunnel its agent holds open, and needs
     * `deviceId`. Credentials, address, and port are ignored for both.
     */
    transport: z.enum(["ssh", "local", "agent"]).default("ssh"),
    /** Required for `transport: "agent"`: which enrolled machine to reach. */
    deviceId: z.string().max(64).optional(),
    /** Optional shell token from that agent's advertised list. */
    shell: z.string().max(64).optional(),
    /**
     * Who is opening this session. Forwarded to the agent so a customer's
     * machine can log who reached it and, under its own policy, refuse anyone
     * its owner has not approved.
     */
    requestedBy: requesterSchema.optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    domain: z.string().optional(),
    security: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    startPath: z.string().optional()
  })
  .superRefine((body, ctx) => {
    // Only the transports that actually open a socket need somewhere to open it.
    if (body.transport === "ssh" && body.port < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["port"], message: "a dialled host needs a port" });
    }
    if (body.transport === "agent" && !body.deviceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deviceId"], message: "agent transport needs a deviceId" });
    }
  });

const sharedSecret = process.env.GATEWAY_SHARED_SECRET;

function isRestAuthorized(request: FastifyRequest) {
  if (!sharedSecret) return true;
  return request.headers.authorization === `Bearer ${sharedSecret}`;
}

const sessionParamsSchema = z.object({ sessionId: z.string() });

/** Long enough for any real path; short enough that nothing here allocates wildly. */
const pathSchema = z.string().min(1).max(4_096);

/** "." is the session's own start directory on both transports. */
const listQuerySchema = z.object({ path: z.string().max(4_096).default(".") });
const readQuerySchema = z.object({ path: pathSchema });
const writeBodySchema = z.object({ path: pathSchema, content: z.string() });
const mkdirBodySchema = z.object({ path: pathSchema });
const renameBodySchema = z.object({ from: pathSchema, to: pathSchema });
const copyBodySchema = z.object({ path: pathSchema, toSessionId: z.string(), toPath: pathSchema });
const removeQuerySchema = z.object({
  path: pathSchema,
  // Not z.coerce.boolean(): that turns the string "false" into true.
  recursive: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true")
});

/**
 * Opens the file transport for a session — the one place the local/remote branch
 * is made, so every file route below is written once against `FileTransport`.
 */
function openFileTransport(session: GatewaySession): Promise<FileTransport> {
  const startPath = typeof session.metadata?.startPath === "string" ? session.metadata.startPath : undefined;

  if (isAgentSession(session)) {
    const deviceId = typeof session.metadata?.deviceId === "string" ? session.metadata.deviceId : "";
    return Promise.resolve(createAgentTransport(deviceId, startPath));
  }
  if (isLocalSession(session)) return Promise.resolve(createLocalTransport(startPath));

  return createSftpTransport(session.id);
}

function replyFileError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof FileOperationError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: "validation_failed", issues: error.issues });
  }

  request.log.error(error);
  return reply.code(500).send({ error: "file_operation_failed" });
}

/**
 * Reports a transport that could not be opened.
 *
 * An agent host that is simply switched off is not an outage — the console
 * should say the machine is not connected rather than blame the service — so it
 * answers 409 while a genuine failure stays a 502.
 */
function replyTransportUnavailable(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof AgentUnavailableError) {
    return reply.code(409).send({ error: error.code });
  }

  request.log.error(error);
  return reply.code(502).send({ error: "sftp_session_unavailable" });
}

/**
 * Runs one file operation for a session.
 *
 * Every single-session file route goes through here: looking the session up,
 * picking the transport, releasing its channel, and naming the failure have to
 * happen identically on all of them.
 */
async function withFileTransport(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  run: (transport: FileTransport) => Promise<unknown>
) {
  const session = getGatewaySession(sessionId);
  if (!session || session.protocol !== "sftp") {
    return reply.code(404).send({ error: "sftp_session_not_found" });
  }

  let transport: FileTransport;
  try {
    transport = await openFileTransport(session);
  } catch (error) {
    return replyTransportUnavailable(request, reply, error);
  }

  try {
    return await run(transport);
  } finally {
    transport.close();
  }
}

/**
 * A terminal, whichever transport produced it. Both the local shell and an
 * agent shell satisfy this, which is what lets one message pump serve both.
 */
interface TerminalStream {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: () => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  end(): void;
}

/** `ws` hands back whichever of its three shapes was cheapest to produce. */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(new Uint8Array(data as ArrayBuffer));
}

/**
 * How often the gateway pings a browser's terminal socket.
 *
 * A shell that is only being watched sends nothing for hours, and everything
 * between here and the browser reaps a connection that quiet — nginx closes an
 * idle proxied WebSocket after 60s by default, and managed load balancers are
 * no more patient. A ping every 25s is what lets a terminal stay open all day.
 */
const WS_PING_INTERVAL_MS = 25_000;

/**
 * How long a socket may stay silent before it is treated as gone.
 *
 * Browsers answer a ping automatically, so silence this long means the tab, the
 * machine or the network is no longer there. Generous on purpose: a laptop that
 * suspends for a minute on a train should find its shell still running, and the
 * cost of waiting is one idle SSH connection.
 */
const WS_SILENCE_LIMIT_MS = 5 * 60_000;

/**
 * Keeps a browser socket open for as long as the browser is really there.
 *
 * Only the agent tunnel had a heartbeat before this; the terminal sockets had
 * none, so an idle session died at whatever timeout the nearest proxy happened
 * to enforce.
 */
function keepSocketAlive(socket: WebSocket, log: (message: string) => void) {
  let lastSeen = Date.now();
  const seen = () => {
    lastSeen = Date.now();
  };

  // Typing counts as being alive too, not just the pong we asked for.
  socket.on("pong", seen);
  socket.on("message", seen);

  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (Date.now() - lastSeen > WS_SILENCE_LIMIT_MS) {
      log("terminal socket stopped answering — closing it");
      // terminate(), not close(): a peer that has not answered a ping in five
      // minutes will not complete a closing handshake either.
      socket.terminate();
      return;
    }
    socket.ping();
  }, WS_PING_INTERVAL_MS);
  timer.unref?.();

  socket.on("close", () => clearInterval(timer));
}

/** The `{"type":"system"}` control frame the browser terminal renders as a notice. */
function systemMessage(socket: WebSocket, data: string) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "system", data }));
}

/**
 * Tells the browser why a session will not start, then closes.
 *
 * A close code alone left the console saying only "couldn't connect", which is
 * true of a typo'd address, a wrong username and a machine that is switched
 * off alike. The frame carries the reason the console shows next to its
 * "Edit host" button, so the fix is one click from the failure.
 */
function failSession(socket: WebSocket, code: string, message: string) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type: "error", code, data: message }));
    // Reason strings are capped at 123 bytes by the protocol; the frame above is
    // the real payload, this is the fallback for a socket that never read it.
    socket.close(1011, message.slice(0, 100));
  }
}

/**
 * Pumps a terminal in both directions over the browser WebSocket.
 *
 * Shared by the local and agent transports so the control-frame vocabulary
 * (`resize`, `data`, and raw-input fallback) cannot drift between them — a
 * divergence there would show up as a terminal that mysteriously ignores
 * window resizes on one kind of host.
 */
function attachTerminal(
  socket: WebSocket,
  shell: TerminalStream,
  options: { closedReason: string; onClose: () => void }
) {
  shell.onData((chunk) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });
  shell.onExit(() => {
    if (socket.readyState === socket.OPEN) socket.close(1000, options.closedReason);
  });

  socket.on("message", (message: Buffer | ArrayBuffer | Buffer[]) => {
    const text = message.toString();
    if (text.startsWith("{")) {
      try {
        const frame = JSON.parse(text) as { type?: string; cols?: number; rows?: number; data?: string };
        if (frame.type === "resize" && typeof frame.cols === "number" && typeof frame.rows === "number") {
          shell.resize(frame.cols, frame.rows);
          return;
        }
        if (frame.type === "data" && typeof frame.data === "string") {
          shell.write(frame.data);
          return;
        }
      } catch {
        // Not a JSON control frame — treat it as raw keyboard input.
      }
    }

    shell.write(text);
  });

  socket.on("close", options.onClose);
}

export async function registerGatewayRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/health", async () => ({
    status: "ok",
    service: "gateway",
    project: "Onshell.cloud",
    version: "0.1.0"
  }));

  app.get("/sessions", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    return listGatewaySessions();
  });

  /**
   * Agents currently connected to *this* node.
   *
   * The API calls it to show a machine as online and to decide whether opening
   * a terminal is even worth attempting. Once there is more than one gateway
   * this becomes a Redis lookup rather than a local map — see agents/registry.ts.
   */
  app.get("/agents", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    return listDevices();
  });

  /**
   * Drops an agent's tunnel immediately.
   *
   * Called by the API when a device is revoked. Without it, revocation would
   * only take effect when the agent next refreshed its 15-minute token — so an
   * open connection, and every terminal on it, would survive being revoked for
   * up to a quarter of an hour. Ending a machine's access has to mean now.
   */
  app.post("/agents/:deviceId/disconnect", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    const { deviceId } = z.object({ deviceId: z.string() }).parse(request.params);
    const reason = z.object({ reason: z.string().max(200).default("access revoked") }).parse(request.body ?? {});

    // Refused first, so a token minted before the revocation cannot simply
    // reconnect: this gateway validates signatures, not database state.
    denyDevice(deviceId);

    const device = getDevice(deviceId);
    // Not an error: a machine that is already offline is in exactly the state
    // the caller wanted, and it is now denied either way.
    if (!device) return { ok: true, wasConnected: false };

    device.kill(reason.reason);
    return { ok: true, wasConnected: true };
  });

  /**
   * Lifts a denial, for a machine that has just been paired again.
   *
   * Without this, re-pairing a revoked computer would appear to succeed and then
   * fail to connect for up to fifteen minutes while the denial aged out — which
   * looks exactly like a broken product.
   */
  app.post("/agents/:deviceId/allow", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    const { deviceId } = z.object({ deviceId: z.string() }).parse(request.params);
    allowDevice(deviceId);
    return { ok: true };
  });

  app.post("/sessions", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    const body = openSessionSchema.parse(request.body);

    if (body.transport === "agent") {
      if (!body.deviceId) return reply.code(400).send({ error: "agent_transport_requires_device_id" });
      // There is no screen to stream from an agent: it serves a shell and a
      // filesystem, not a remote desktop.
      if (body.protocol === "rdp") {
        return reply.code(400).send({ error: "agent_transport_supports_ssh_and_sftp_only" });
      }

      try {
        const agent =
          body.protocol === "ssh"
            ? await openAgentSession({
                hostId: body.hostId,
                deviceId: body.deviceId,
                shell: body.shell,
                startPath: body.startPath,
                requestedBy: body.requestedBy
              })
            : await openAgentFileSession({
                hostId: body.hostId,
                deviceId: body.deviceId,
                startPath: body.startPath,
                requestedBy: body.requestedBy
              });

        return reply.code(201).send({
          session: agent,
          connectUrl: `${config.gatewayBaseUrl}/sessions/${agent.id}`,
          websocketUrl: agent.websocketPath ? `${config.gatewayBaseUrl}${agent.websocketPath}` : undefined
        });
      } catch (error) {
        if (error instanceof AgentUnavailableError) {
          // 409, not 502: nothing failed, the machine is simply not connected
          // right now, and the console should say so rather than blaming us.
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    }

    if (body.transport === "local") {
      if (body.protocol === "rdp") {
        return reply.code(400).send({ error: "local_transport_supports_ssh_and_sftp_only" });
      }

      const local =
        body.protocol === "ssh"
          ? openLocalSession({ hostId: body.hostId, startPath: body.startPath })
          : openLocalFileSession({ hostId: body.hostId, startPath: body.startPath });

      return reply.code(201).send({
        session: local,
        connectUrl: `${config.gatewayBaseUrl}/sessions/${local.id}`,
        websocketUrl: local.websocketPath ? `${config.gatewayBaseUrl}${local.websocketPath}` : undefined
      });
    }

    const session =
      body.protocol === "ssh"
        ? openSshSession(body)
        : body.protocol === "sftp"
          ? openSftpSession(body)
          : openRdpSession(body);

    return reply.code(201).send({
      session,
      connectUrl: `${config.gatewayBaseUrl}/sessions/${session.id}`,
      websocketUrl: session.websocketPath ? `${config.gatewayBaseUrl}${session.websocketPath}` : undefined
    });
  });

  app.get("/sessions/:sessionId", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    const session = getGatewaySession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: "gateway_session_not_found" });
    }

    return session;
  });

  app.post("/sessions/:sessionId/close", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    closeSshClient(sessionId);
    closeLocalShell(sessionId);
    closeAgentShell(sessionId);
    const session = updateGatewaySession(sessionId, { status: "closed" });
    if (!session) {
      return reply.code(404).send({ error: "gateway_session_not_found" });
    }

    return session;
  });

  // Returns the resolved absolute path alongside the entries, so the console's
  // breadcrumb shows where "." actually landed on either transport.
  app.get("/sessions/:sessionId/sftp/list", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = listQuerySchema.parse(request.query);
      return await withFileTransport(request, reply, sessionId, (transport) => listDirectory(transport, query.path));
    } catch (error) {
      return replyFileError(request, reply, error);
    }
  });

  app.get("/sessions/:sessionId/sftp/read", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = readQuerySchema.parse(request.query);
      return await withFileTransport(request, reply, sessionId, (transport) => readTextFile(transport, query.path));
    } catch (error) {
      return replyFileError(request, reply, error);
    }
  });

  app.put(
    "/sessions/:sessionId/sftp/write",
    // A file right at the 1 MiB editor ceiling does not fit in Fastify's default
    // 1 MiB body limit once it is JSON-escaped, so this route gets its own.
    { bodyLimit: 2 * MAX_TEXT_FILE_BYTES },
    async (request, reply) => {
      if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
      try {
        const { sessionId } = sessionParamsSchema.parse(request.params);
        const body = writeBodySchema.parse(request.body);
        return await withFileTransport(request, reply, sessionId, async (transport) => ({
          ok: true,
          ...(await writeTextFile(transport, body.path, body.content))
        }));
      } catch (error) {
        return replyFileError(request, reply, error);
      }
    }
  );

  app.post("/sessions/:sessionId/sftp/mkdir", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = mkdirBodySchema.parse(request.body);
      return await withFileTransport(request, reply, sessionId, async (transport) => ({
        ok: true,
        ...(await makeDirectory(transport, body.path))
      }));
    } catch (error) {
      return replyFileError(request, reply, error);
    }
  });

  app.post("/sessions/:sessionId/sftp/rename", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = renameBodySchema.parse(request.body);
      return await withFileTransport(request, reply, sessionId, async (transport) => ({
        ok: true,
        ...(await renamePath(transport, body.from, body.to))
      }));
    } catch (error) {
      return replyFileError(request, reply, error);
    }
  });

  app.delete("/sessions/:sessionId/sftp/remove", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = removeQuerySchema.parse(request.query);
      return await withFileTransport(request, reply, sessionId, async (transport) => ({
        ok: true,
        ...(await removePath(transport, query.path, query.recursive))
      }));
    } catch (error) {
      return replyFileError(request, reply, error);
    }
  });

  /**
   * Copies between two open sessions.
   *
   * Both sessions are held in this process, so `copyPath` pipes the source
   * session's channel into the destination session's — the payload never travels
   * back through the API or the browser, whichever transports the two ends use.
   *
   * Authorisation of *both* session ids happens in the API service: the gateway
   * has no notion of users, orgs or host grants, so all it can check is that both
   * ids name an open file session.
   */
  app.post("/sessions/:sessionId/sftp/copy", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = copyBodySchema.parse(request.body);

      const source = getGatewaySession(sessionId);
      const target = getGatewaySession(body.toSessionId);
      if (!source || source.protocol !== "sftp" || !target || target.protocol !== "sftp") {
        return reply.code(404).send({ error: "sftp_session_not_found" });
      }

      let from: FileTransport;
      let to: FileTransport;
      try {
        from = await openFileTransport(source);
      } catch (error) {
        return replyTransportUnavailable(request, reply, error);
      }
      try {
        to = await openFileTransport(target);
      } catch (error) {
        from.close();
        return replyTransportUnavailable(request, reply, error);
      }

      try {
        return { ok: true, ...(await copyPath(from, body.path, to, body.toPath)) };
      } finally {
        from.close();
        to.close();
      }
    } catch (error) {
      return replyFileError(request, reply, error);
    }
  });

  app.get("/ws/ssh/:sessionId", { websocket: true }, async (socket, request) => {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    const session = getGatewaySession(sessionId);
    if (!session || session.protocol !== "ssh") {
      socket.close(1008, "SSH session not found");
      return;
    }

    // Every transport below shares one browser socket, so the heartbeat is set
    // up once here rather than three times.
    keepSocketAlive(socket, (message) => request.log.info({ sessionId }, message));

    if (isAgentSession(session)) {
      try {
        const shell = await openAgentShell(session);
        systemMessage(
          socket,
          shell.pty
            ? "Connected to your machine."
            : "Connected to your machine (no pty available — job control and resize are disabled)."
        );

        // The tunnel can drop and come back under a session that stays open, so
        // the agent transport has something the others do not: news for the
        // user mid-session.
        shell.onNotice((text) => systemMessage(socket, text));
        attachTerminal(socket, shell, {
          closedReason: "Agent shell closed",
          onClose: () => closeAgentShell(sessionId)
        });
      } catch (error) {
        if (error instanceof AgentUnavailableError) {
          request.log.warn({ sessionId, reason: error.code }, "agent shell unavailable");
          failSession(socket, error.code, `That machine is not reachable right now (${error.code}).`);
          return;
        }

        request.log.error(error);
        failSession(socket, "agent_shell_failed", "That machine accepted the connection but could not start a shell.");
      }
      return;
    }

    if (isLocalSession(session)) {
      try {
        const shell = await openLocalShell(sessionId);
        if (!shell.pty) {
          request.log.warn({ sessionId, reason: shell.ptyError }, "local shell running without a pty");
        }
        systemMessage(
          socket,
          shell.pty
            ? "Onshell.cloud local shell connected."
            : "Onshell.cloud local shell connected (no pty available — job control and resize are disabled)."
        );

        attachTerminal(socket, shell, {
          closedReason: "Local shell closed",
          onClose: () => closeLocalShell(sessionId)
        });
      } catch (error) {
        request.log.error(error);
        failSession(
          socket,
          "local_shell_failed",
          error instanceof Error && error.message
            ? `The local shell could not start: ${error.message}`
            : "The local shell could not start."
        );
      }
      return;
    }

    try {
      const shell = await openShell(sessionId);
      socket.send(JSON.stringify({ type: "system", data: "Onshell.cloud SSH gateway connected." }));

      shell.on("data", (data: Buffer) => {
        if (socket.readyState === socket.OPEN) socket.send(data.toString("utf8"));
      });
      shell.on("close", () => {
        if (socket.readyState === socket.OPEN) socket.close(1000, "SSH shell closed");
      });
      shell.stderr.on("data", (data: Buffer) => {
        if (socket.readyState === socket.OPEN) socket.send(data.toString("utf8"));
      });

      socket.on("message", (message: Buffer | ArrayBuffer | Buffer[]) => {
        const text = message.toString();
        if (text.startsWith("{")) {
          try {
            const frame = JSON.parse(text) as { type?: string; cols?: number; rows?: number; data?: string };
            if (frame.type === "resize" && typeof frame.cols === "number" && typeof frame.rows === "number") {
              shell.setWindow(frame.rows, frame.cols, 0, 0);
              return;
            }
            if (frame.type === "data" && typeof frame.data === "string") {
              shell.write(frame.data);
              return;
            }
          } catch {
            // Not a JSON control frame — fall through and treat it as raw input.
          }
        }

        shell.write(text);
      });
      socket.on("close", () => {
        shell.end();
      });
    } catch (error) {
      request.log.error({ err: error, sessionId }, "ssh shell failed");
      if (error instanceof SshConnectionError) {
        failSession(socket, error.code, error.message);
        return;
      }
      failSession(
        socket,
        "shell_failed",
        error instanceof Error && error.message
          ? `The server accepted the connection but refused a shell: ${error.message}`
          : "The server accepted the connection but refused a shell."
      );
    }
  });

  /**
   * The agent's own connection. Never a browser.
   *
   * Authentication is a short-lived JWT the API minted from the device's
   * long-lived token, so the gateway checks a signature and reads the claims
   * without a database — the same shape as everything else it does. The token
   * pins `typ: "agent"`, which is what stops an ordinary user access token,
   * signed with the very same secret, from being presented here.
   */
  app.get("/ws/agent", { websocket: true }, (socket, request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const claims = token ? verifyAgentToken(token, config.jwtSecret) : undefined;
    if (!claims) {
      socket.close(1008, "Unauthorized");
      return;
    }
    if (isDeviceDenied(claims.sub)) {
      request.log.warn({ deviceId: claims.sub }, "refused a revoked device still holding a valid token");
      socket.close(1008, "Revoked");
      return;
    }

    const device = getOrCreateDevice(claims.sub, claims.organizationId, (message, detail) =>
      request.log.info(detail ?? {}, message)
    );
    device.attach(socket);

    socket.on("message", (message: RawData, isBinary: boolean) => {
      device.handleMessage(toBuffer(message), isBinary);
    });

    socket.on("close", () => {
      // Terminals are not killed here: the device holds them for a grace window
      // so a laptop switching networks does not lose a running build.
      device.detach(socket);
    });

    socket.on("error", (error) => {
      request.log.warn({ err: error, deviceId: claims.sub }, "agent socket error");
    });
  });

  app.get("/ws/rdp/:sessionId", { websocket: true }, (socket, request) => {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    const session = getGatewaySession(sessionId);
    if (!session || session.protocol !== "rdp") {
      socket.close(1008, "RDP session not found");
      return;
    }

    keepSocketAlive(socket, (message) => request.log.info({ sessionId }, message));

    const guacd = createGuacdTunnel(
      sessionId,
      config,
      (chunk) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk);
      },
      (error) => {
        request.log.error(error);
        if (socket.readyState === socket.OPEN) socket.close(1011, "guacd tunnel failed");
      },
      () => {
        if (socket.readyState === socket.OPEN) socket.close(1000, "guacd tunnel closed");
      }
    );

    socket.on("message", (message: Buffer | ArrayBuffer | Buffer[]) => {
      if (!guacd.destroyed) guacd.write(Buffer.isBuffer(message) ? message : Buffer.from(message.toString()));
    });
    socket.on("close", () => {
      guacd.end();
    });
  });
}
