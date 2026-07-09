import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { z } from "zod";
import { openRdpSession } from "./protocols/rdp.js";
import { listSftpDirectory, openSftpSession } from "./protocols/sftp.js";
import { createGuacdTunnel } from "./protocols/rdp-connections.js";
import { closeSshClient, openShell } from "./protocols/ssh-connections.js";
import { openSshSession } from "./protocols/ssh.js";
import { getGatewaySession, listGatewaySessions, updateGatewaySession } from "./registry.js";

const openSessionSchema = z.object({
  protocol: z.enum(["ssh", "sftp", "rdp"]),
  hostId: z.string(),
  address: z.string(),
  port: z.number().int().min(1).max(65535),
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

export async function registerGatewayRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/health", async () => ({
    status: "ok",
    service: "gateway",
    project: "Onshell.cloud",
    version: "0.1.0"
  }));

  app.get("/sessions", async () => listGatewaySessions());

  app.post("/sessions", async (request, reply) => {
    const body = openSessionSchema.parse(request.body);
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
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    const session = getGatewaySession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: "gateway_session_not_found" });
    }

    return session;
  });

  app.post("/sessions/:sessionId/close", async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    closeSshClient(sessionId);
    const session = updateGatewaySession(sessionId, { status: "closed" });
    if (!session) {
      return reply.code(404).send({ error: "gateway_session_not_found" });
    }

    return session;
  });

  app.get("/sessions/:sessionId/sftp/list", async (request, reply) => {
    try {
      const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
      const query = z.object({ path: z.string().default("/") }).parse(request.query);
      const session = getGatewaySession(sessionId);
      if (!session || session.protocol !== "sftp") {
        return reply.code(404).send({ error: "sftp_session_not_found" });
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
        shell.write(message.toString());
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
