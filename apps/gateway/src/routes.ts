/**
 * Gateway wire protocol
 * =====================
 *
 * REST (called by the API service, never by browsers):
 *   - GET  /health                          liveness probe (never requires auth)
 *   - POST /sessions                        open a session (body: openSessionSchema below)
 *   - GET  /sessions                        list gateway sessions
 *   - GET  /sessions/:sessionId             inspect one gateway session
 *   - POST /sessions/:sessionId/close       terminate a gateway session
 *   - GET  /sessions/:sessionId/sftp/list   list a directory over SFTP (?path=/)
 *   When the GATEWAY_SHARED_SECRET environment variable is set, every REST
 *   endpoint except /health requires `Authorization: Bearer <secret>`.
 *
 *   POST /sessions accepts `transport: "local"`, which serves the shell and the
 *   directory listing from this machine instead of dialling out over SSH — the
 *   built-in host every workspace gets. See protocols/local.ts.
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
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { z } from "zod";
import {
  closeLocalShell,
  listLocalDirectory,
  openLocalFileSession,
  openLocalSession,
  openLocalShell
} from "./protocols/local.js";
import { openRdpSession } from "./protocols/rdp.js";
import { listSftpDirectory, openSftpSession } from "./protocols/sftp.js";
import { createGuacdTunnel } from "./protocols/rdp-connections.js";
import { closeSshClient, openShell } from "./protocols/ssh-connections.js";
import { openSshSession } from "./protocols/ssh.js";
import { getGatewaySession, listGatewaySessions, updateGatewaySession, type GatewaySession } from "./registry.js";

/** Local sessions are tagged at creation; everything else dials out over SSH. */
function isLocalSession(session: GatewaySession) {
  return session.metadata?.transport === "local";
}

const openSessionSchema = z.object({
  protocol: z.enum(["ssh", "sftp", "rdp"]),
  hostId: z.string(),
  address: z.string(),
  port: z.number().int().min(1).max(65535),
  /**
   * "local" runs the shell and the file listing in this process instead of
   * dialling out — the built-in host every workspace gets. Credentials, address,
   * and port are ignored for it.
   */
  transport: z.enum(["ssh", "local"]).default("ssh"),
  username: z.string().optional(),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  domain: z.string().optional(),
  security: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  startPath: z.string().optional()
});

const sharedSecret = process.env.GATEWAY_SHARED_SECRET;

function isRestAuthorized(request: FastifyRequest) {
  if (!sharedSecret) return true;
  return request.headers.authorization === `Bearer ${sharedSecret}`;
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

  app.post("/sessions", async (request, reply) => {
    if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
    const body = openSessionSchema.parse(request.body);

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
    const session = updateGatewaySession(sessionId, { status: "closed" });
    if (!session) {
      return reply.code(404).send({ error: "gateway_session_not_found" });
    }

    return session;
  });

  app.get("/sessions/:sessionId/sftp/list", async (request, reply) => {
    try {
      if (!isRestAuthorized(request)) return reply.code(401).send({ error: "unauthorized" });
      const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
      const query = z.object({ path: z.string().default("/") }).parse(request.query);
      const session = getGatewaySession(sessionId);
      if (!session || session.protocol !== "sftp") {
        return reply.code(404).send({ error: "sftp_session_not_found" });
      }

      if (isLocalSession(session)) {
        // Returns the resolved absolute path, so the console's breadcrumb shows
        // where "." actually landed.
        return listLocalDirectory(String(session.metadata?.startPath ?? ""), query.path);
      }

      return {
        path: query.path,
        entries: await listSftpDirectory(sessionId, query.path)
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "sftp_list_failed" });
    }
  });

  app.get("/ws/ssh/:sessionId", { websocket: true }, async (socket, request) => {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    const session = getGatewaySession(sessionId);
    if (!session || session.protocol !== "ssh") {
      socket.close(1008, "SSH session not found");
      return;
    }

    if (isLocalSession(session)) {
      try {
        const shell = await openLocalShell(sessionId);
        if (!shell.pty) {
          request.log.warn({ sessionId, reason: shell.ptyError }, "local shell running without a pty");
        }
        socket.send(
          JSON.stringify({
            type: "system",
            data: shell.pty
              ? "Onshell.cloud local shell connected."
              : "Onshell.cloud local shell connected (no pty available — job control and resize are disabled)."
          })
        );

        shell.onData((chunk) => {
          if (socket.readyState === socket.OPEN) socket.send(chunk);
        });
        shell.onExit(() => {
          if (socket.readyState === socket.OPEN) socket.close(1000, "Local shell closed");
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
        socket.on("close", () => {
          closeLocalShell(sessionId);
        });
      } catch (error) {
        request.log.error(error);
        socket.close(1011, "Local shell failed");
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
      request.log.error(error);
      socket.close(1011, "SSH shell failed");
    }
  });

  app.get("/ws/rdp/:sessionId", { websocket: true }, (socket, request) => {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    const session = getGatewaySession(sessionId);
    if (!session || session.protocol !== "rdp") {
      socket.close(1008, "RDP session not found");
      return;
    }

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
