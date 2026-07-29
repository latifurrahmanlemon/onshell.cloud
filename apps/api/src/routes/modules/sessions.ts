import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canEditFiles, canOpenSession } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { decryptSecret } from "../../lib/encryption.js";
import { accessibleHostFilter } from "../../lib/host-access.js";
import { prisma } from "../../lib/prisma.js";
import {
  recordAudit,
  sessionProtocolFromPrisma,
  sessionProtocolToPrisma,
  toRemoteSession
} from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";

const openSessionSchema = z.object({
  hostId: z.string(),
  protocol: z.enum(["ssh", "sftp", "rdp"]).default("ssh"),
  credentialId: z.string().optional()
});

const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

/**
 * Mirrors MAX_EDITABLE_FILE_BYTES in the console. Enforced again here so an
 * oversized save is rejected before it is forwarded; the gateway then measures
 * the real UTF-8 byte length, which this character count only approximates.
 */
const MAX_EDITABLE_FILE_CHARS = 1024 * 1024;

const sessionParamsSchema = z.object({ sessionId: z.string() });
const filePathSchema = z.string().min(1).max(4_096);
const readFileQuerySchema = z.object({ path: filePathSchema });
const writeFileBodySchema = z.object({ path: filePathSchema, content: z.string().max(MAX_EDITABLE_FILE_CHARS) });
const makeDirectoryBodySchema = z.object({ path: filePathSchema });
const renamePathBodySchema = z.object({ from: filePathSchema, to: filePathSchema });
const copyPathBodySchema = z.object({
  path: filePathSchema,
  toSessionId: z.string().min(1),
  toPath: filePathSchema
});
const deletePathQuerySchema = z.object({
  path: filePathSchema,
  // Not z.coerce.boolean(): that turns the string "false" into true.
  recursive: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true")
});

interface GatewayOpenResponse {
  session: { id: string; status: string; websocketPath?: string };
  connectUrl: string;
  websocketUrl?: string;
}

function gatewayHeaders() {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sharedSecret = process.env.GATEWAY_SHARED_SECRET;
  if (sharedSecret) headers.authorization = `Bearer ${sharedSecret}`;
  return headers;
}

function toWebsocketUrl(gatewayBaseUrl: string, path: string) {
  return `${gatewayBaseUrl.replace(/^http/, "ws")}${path}`;
}

/** Whoever `getAuthenticatedUser` handed back — named so the file helpers can take it. */
type FileActor = NonNullable<Awaited<ReturnType<typeof getAuthenticatedUser>>>;

/** Why a file session could not be used, in the shape the console reads. */
interface FileSessionFailure {
  status: number;
  error: string;
  message?: string;
}

/**
 * Resolves one open SFTP session that the caller is allowed to reach.
 *
 * Every file route runs this, and the copy route runs it once per session id in
 * the request. The gateway has no notion of users, organizations or host grants —
 * it trusts anything that can reach it — so the organization scope and the
 * per-host grant have to be proved here, on every request, for every session
 * involved. Letting the source session's check stand in for a copy's destination
 * is exactly how someone would write into a host they cannot see.
 */
async function findOpenFileSession(actor: FileActor, sessionId: string) {
  const accessFilter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);
  const session = await prisma.session.findFirst({
    where: { id: sessionId, organizationId: actor.organizationId, host: accessFilter }
  });
  if (!session) {
    return { ok: false as const, failure: { status: 404, error: "session_not_found" } satisfies FileSessionFailure };
  }
  if (session.protocol !== "SFTP") {
    return { ok: false as const, failure: { status: 400, error: "not_a_file_session" } satisfies FileSessionFailure };
  }
  if (!session.gatewaySessionId || session.status === "CLOSED" || session.status === "FAILED") {
    return {
      ok: false as const,
      failure: {
        status: 409,
        error: "session_not_open",
        message: "This file session is no longer open. Open it again from the host list."
      } satisfies FileSessionFailure
    };
  }

  return { ok: true as const, session, gatewaySessionId: session.gatewaySessionId };
}

function sendFileFailure(reply: FastifyReply, failure: FileSessionFailure) {
  return reply.code(failure.status).send({
    error: failure.error,
    ...(failure.message ? { message: failure.message } : {})
  });
}

type GatewayFileResult = { ok: true; payload: unknown } | { ok: false; failure: FileSessionFailure };

/**
 * Forwards one file operation to the gateway.
 *
 * The gateway's 4xx answers name something the caller can act on
 * (`path_not_found`, `permission_denied`, `file_too_large`, …) so they are passed
 * through with their status. A 5xx or an unreachable gateway is our problem, not
 * theirs, and collapses to a 502 with nothing of the transport in it.
 */
async function callGatewayFileOperation(
  log: FastifyRequest["log"],
  url: string,
  init?: { method: string; body?: string }
): Promise<GatewayFileResult> {
  const headers = gatewayHeaders();
  // Fastify refuses a JSON content-type with an empty payload, and the read and
  // delete operations send no body at all.
  if (init?.body === undefined) delete headers["content-type"];

  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body
    });
  } catch (gatewayError) {
    log.error({ err: gatewayError }, "gateway file operation failed");
    return {
      ok: false,
      failure: {
        status: 502,
        error: "gateway_unreachable",
        message: "The session gateway could not be reached. Please try again shortly."
      }
    };
  }

  const payload = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  if (response.ok) return { ok: true, payload };

  if (response.status < 500) {
    return {
      ok: false,
      failure: {
        status: response.status,
        error: typeof payload?.error === "string" ? payload.error : "file_operation_failed",
        message: typeof payload?.message === "string" ? payload.message : undefined
      }
    };
  }

  log.error({ status: response.status, payload }, "gateway file operation failed");
  return {
    ok: false,
    failure: {
      status: 502,
      error: "file_operation_failed",
      message: "That file operation could not be completed. The session may have expired."
    }
  };
}

export async function registerSessionRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/sessions", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const query = listSessionsQuerySchema.parse(request.query);
      const accessFilter = await accessibleHostFilter(user.id, user.role, user.organizationId);
      const sessions = await prisma.session.findMany({
        where: { organizationId: user.organizationId, host: accessFilter },
        orderBy: { startedAt: "desc" },
        take: query.limit
      });

      return sessions.map(toRemoteSession);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/sessions", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canOpenSession(actor.role)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const body = openSessionSchema.parse(request.body);
      const accessFilter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);
      const host = await prisma.host.findFirst({
        where: { ...accessFilter, id: body.hostId },
        include: { credentials: { orderBy: { createdAt: "asc" }, take: 1 } }
      });
      if (!host) {
        // Separate "you have no grant" from "no such host" so the console can
        // tell the member to ask for access instead of to refresh their list.
        // Safe to distinguish here: the caller is already inside the org, and
        // this only ever runs on the failure path.
        const inOrganization = await prisma.host.count({
          where: { id: body.hostId, organizationId: actor.organizationId }
        });
        return inOrganization > 0
          ? reply.code(403).send({ error: "host_access_denied" })
          : reply.code(404).send({ error: "host_not_found" });
      }

      if (host.isLocal) {
        if (body.protocol === "rdp") {
          return reply.code(400).send({
            error: "protocol_unsupported_for_local_host",
            message: "The built-in local host serves a terminal and files, not a remote desktop."
          });
        }
        // Re-checked here, not just at provisioning: turning the flag off has to
        // disable rows that already exist.
        if (!config.localShellEnabled) {
          return reply.code(403).send({
            error: "local_shell_disabled",
            message: "Local shell access is disabled on this deployment."
          });
        }
      }

      // The local host runs the shell inside the gateway process, so there is
      // nothing to authenticate against and no credential to look up.
      const credential = host.isLocal
        ? null
        : body.credentialId
          ? await prisma.credential.findFirst({
              where: { id: body.credentialId, organizationId: actor.organizationId }
            })
          : host.credentials[0];
      if (!credential && !host.isLocal) {
        return body.credentialId
          ? reply.code(404).send({ error: "credential_not_found" })
          : reply.code(400).send({ error: "no_credential_for_host" });
      }

      // Record when this credential was last used to open a session (best-effort).
      if (credential) {
        void prisma.credential
          .update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);
      }

      const subscription = await prisma.subscription.findFirst({
        where: {
          organizationId: actor.organizationId,
          status: { in: ["ACTIVE", "TRIALING"] }
        },
        include: { plan: true },
        orderBy: { createdAt: "desc" }
      });
      const maxConcurrentSessions = subscription?.plan.maxConcurrentSessions;
      if (maxConcurrentSessions != null) {
        const activeSessions = await prisma.session.count({
          where: {
            organizationId: actor.organizationId,
            status: { in: ["PENDING", "ACTIVE"] }
          }
        });
        if (activeSessions >= maxConcurrentSessions) {
          return reply.code(403).send({
            error: "concurrent_session_limit_reached",
            limit: maxConcurrentSessions
          });
        }
      }

      const secret = credential
        ? decryptSecret(
            {
              encryptedPayload: credential.encryptedPayload,
              nonce: credential.nonce,
              authTag: credential.authTag
            },
            config.masterEncryptionKey
          )
        : null;
      const gatewayBody = {
        protocol: body.protocol,
        hostId: host.id,
        address: host.address,
        port: host.port,
        username: host.username ?? undefined,
        // "local" tells the gateway to spawn a shell / read the filesystem in
        // process rather than dial out over SSH.
        ...(host.isLocal
          ? { transport: "local" as const }
          : credential?.kind === "SSH_KEY"
            ? { privateKey: secret ?? undefined }
            : { password: secret ?? undefined })
      };

      let gateway: GatewayOpenResponse;
      try {
        const response = await fetch(`${config.gatewayBaseUrl}/sessions`, {
          method: "POST",
          headers: gatewayHeaders(),
          body: JSON.stringify(gatewayBody)
        });
        if (!response.ok) {
          throw new Error(`gateway responded with status ${response.status}`);
        }
        gateway = (await response.json()) as GatewayOpenResponse;
      } catch (gatewayError) {
        request.log.error({ err: gatewayError }, "gateway session handoff failed");
        const failed = await prisma.session.create({
          data: {
            organizationId: actor.organizationId,
            hostId: host.id,
            userId: actor.id,
            protocol: sessionProtocolToPrisma[body.protocol],
            status: "FAILED",
            endedAt: new Date()
          }
        });
        await recordAudit({
          organizationId: actor.organizationId,
          actorId: actor.id,
          action: `${body.protocol}.session.failed`,
          targetType: "host",
          targetId: host.id,
          ipAddress: request.ip,
          metadata: { sessionId: failed.id, reason: "gateway_unreachable" }
        });

        return reply.code(502).send({
          error: "gateway_unreachable",
          message: "The session gateway could not be reached. Please try again shortly."
        });
      }

      const session = await prisma.session.create({
        data: {
          organizationId: actor.organizationId,
          hostId: host.id,
          userId: actor.id,
          protocol: sessionProtocolToPrisma[body.protocol],
          status: "ACTIVE",
          gatewaySessionId: gateway.session.id
        }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: `${body.protocol}.session.open`,
        targetType: "host",
        targetId: host.id,
        ipAddress: request.ip,
        metadata: {
          sessionId: session.id,
          gatewaySessionId: gateway.session.id,
          credentialId: credential?.id ?? null,
          ...(host.isLocal && { local: true })
        }
      });

      const websocketUrl =
        body.protocol === "sftp"
          ? null
          : toWebsocketUrl(config.gatewayBaseUrl, `/ws/${body.protocol}/${gateway.session.id}`);

      return reply.code(201).send({
        session: toRemoteSession(session),
        websocketUrl
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * Lists a directory for an open SFTP session.
   *
   * This exists so the browser never talks to the gateway's REST API directly.
   * The gateway trusts whoever can reach it — it has no notion of users, orgs, or
   * host grants — so a listing requested straight from the browser is only as
   * protected as the unguessability of a gateway session id. Routing it through
   * here re-applies the caller's organization and per-host access, and lets the
   * gateway sit behind GATEWAY_SHARED_SECRET where nothing but this service can
   * reach it.
   *
   * Keyed by the Onshell session id, not the gateway's: the gateway id is an
   * internal handle and no longer needs to be exposed to the client at all.
   */
  app.get("/sessions/:sessionId/files", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
      const query = z.object({ path: z.string().max(4_096).default(".") }).parse(request.query);

      const accessFilter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);
      const session = await prisma.session.findFirst({
        where: { id: sessionId, organizationId: actor.organizationId, host: accessFilter }
      });
      if (!session) return reply.code(404).send({ error: "session_not_found" });
      if (session.protocol !== "SFTP") {
        return reply.code(400).send({ error: "not_a_file_session" });
      }
      if (!session.gatewaySessionId || session.status === "CLOSED" || session.status === "FAILED") {
        return reply.code(409).send({
          error: "session_not_open",
          message: "This file session is no longer open. Open it again from the host list."
        });
      }

      let payload: unknown;
      try {
        const response = await fetch(
          `${config.gatewayBaseUrl}/sessions/${session.gatewaySessionId}/sftp/list?path=${encodeURIComponent(query.path)}`,
          { headers: gatewayHeaders() }
        );
        if (!response.ok) throw new Error(`gateway responded with status ${response.status}`);
        payload = await response.json();
      } catch (gatewayError) {
        request.log.error({ err: gatewayError, sessionId: session.id }, "sftp listing failed");
        return reply.code(502).send({
          error: "sftp_list_failed",
          message: "Could not read that directory. The session may have expired."
        });
      }

      return payload;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /*
   * File operations on an open SFTP session — the dual-pane file manager.
   *
   * All of them share the listing's security model above: authenticate, resolve
   * the session through `accessibleHostFilter`, confirm it is an open SFTP
   * session, then talk to the gateway with the shared secret. The five mutating
   * routes additionally require `canEditFiles`: the session lookup is scoped to
   * the organization and the host grant but *not* to the user who opened it, so
   * without this an auditor could borrow a colleague's open session to write to a
   * host. Reading mirrors the listing, which auditors are meant to have.
   */
  app.get("/sessions/:sessionId/files/content", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = readFileQuerySchema.parse(request.query);

      const resolved = await findOpenFileSession(actor, sessionId);
      if (!resolved.ok) return sendFileFailure(reply, resolved.failure);

      const result = await callGatewayFileOperation(
        request.log,
        `${config.gatewayBaseUrl}/sessions/${resolved.gatewaySessionId}/sftp/read?path=${encodeURIComponent(query.path)}`
      );
      if (!result.ok) return sendFileFailure(reply, result.failure);

      return result.payload;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.put("/sessions/:sessionId/files/content", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canEditFiles(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = writeFileBodySchema.parse(request.body);

      const resolved = await findOpenFileSession(actor, sessionId);
      if (!resolved.ok) return sendFileFailure(reply, resolved.failure);

      const result = await callGatewayFileOperation(
        request.log,
        `${config.gatewayBaseUrl}/sessions/${resolved.gatewaySessionId}/sftp/write`,
        { method: "PUT", body: JSON.stringify({ path: body.path, content: body.content }) }
      );
      if (!result.ok) return sendFileFailure(reply, result.failure);

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "sftp.file.write",
        targetType: "host",
        targetId: resolved.session.hostId,
        ipAddress: request.ip,
        metadata: { sessionId: resolved.session.id, path: body.path, bytes: Buffer.byteLength(body.content, "utf8") }
      });

      return result.payload;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/sessions/:sessionId/files/mkdir", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canEditFiles(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = makeDirectoryBodySchema.parse(request.body);

      const resolved = await findOpenFileSession(actor, sessionId);
      if (!resolved.ok) return sendFileFailure(reply, resolved.failure);

      const result = await callGatewayFileOperation(
        request.log,
        `${config.gatewayBaseUrl}/sessions/${resolved.gatewaySessionId}/sftp/mkdir`,
        { method: "POST", body: JSON.stringify({ path: body.path }) }
      );
      if (!result.ok) return sendFileFailure(reply, result.failure);

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "sftp.file.mkdir",
        targetType: "host",
        targetId: resolved.session.hostId,
        ipAddress: request.ip,
        metadata: { sessionId: resolved.session.id, path: body.path }
      });

      return result.payload;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/sessions/:sessionId/files/rename", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canEditFiles(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = renamePathBodySchema.parse(request.body);

      const resolved = await findOpenFileSession(actor, sessionId);
      if (!resolved.ok) return sendFileFailure(reply, resolved.failure);

      const result = await callGatewayFileOperation(
        request.log,
        `${config.gatewayBaseUrl}/sessions/${resolved.gatewaySessionId}/sftp/rename`,
        { method: "POST", body: JSON.stringify({ from: body.from, to: body.to }) }
      );
      if (!result.ok) return sendFileFailure(reply, result.failure);

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "sftp.file.rename",
        targetType: "host",
        targetId: resolved.session.hostId,
        ipAddress: request.ip,
        metadata: { sessionId: resolved.session.id, from: body.from, to: body.to }
      });

      return result.payload;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.delete("/sessions/:sessionId/files", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canEditFiles(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = deletePathQuerySchema.parse(request.query);

      const resolved = await findOpenFileSession(actor, sessionId);
      if (!resolved.ok) return sendFileFailure(reply, resolved.failure);

      const search = new URLSearchParams({ path: query.path, recursive: query.recursive ? "true" : "false" });
      const result = await callGatewayFileOperation(
        request.log,
        `${config.gatewayBaseUrl}/sessions/${resolved.gatewaySessionId}/sftp/remove?${search.toString()}`,
        { method: "DELETE" }
      );
      if (!result.ok) return sendFileFailure(reply, result.failure);

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "sftp.file.delete",
        targetType: "host",
        targetId: resolved.session.hostId,
        ipAddress: request.ip,
        metadata: { sessionId: resolved.session.id, path: query.path, recursive: query.recursive }
      });

      return result.payload;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * Copies a path from this session into another open session — the paste half of
   * the dual-pane browser.
   *
   * The destination session is resolved with its own `accessibleHostFilter`
   * check, not the source's: this is the one route where reusing the first check
   * would let a member copy into a host they have no grant for. Only the two
   * gateway session ids are then handed to the gateway, which pipes the bytes
   * from one session to the other inside its own process.
   */
  app.post("/sessions/:sessionId/files/copy", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canEditFiles(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = copyPathBodySchema.parse(request.body);

      const source = await findOpenFileSession(actor, sessionId);
      if (!source.ok) return sendFileFailure(reply, source.failure);
      const target = await findOpenFileSession(actor, body.toSessionId);
      if (!target.ok) {
        // Reported against the destination so the console can say which pane is
        // at fault rather than blaming the copy as a whole.
        return reply.code(target.failure.status).send({
          error: `destination_${target.failure.error}`,
          ...(target.failure.message ? { message: target.failure.message } : {})
        });
      }

      const result = await callGatewayFileOperation(
        request.log,
        `${config.gatewayBaseUrl}/sessions/${source.gatewaySessionId}/sftp/copy`,
        {
          method: "POST",
          body: JSON.stringify({
            path: body.path,
            toSessionId: target.gatewaySessionId,
            toPath: body.toPath
          })
        }
      );
      if (!result.ok) return sendFileFailure(reply, result.failure);

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "sftp.file.copy",
        targetType: "host",
        targetId: target.session.hostId,
        ipAddress: request.ip,
        metadata: {
          sessionId: source.session.id,
          fromHostId: source.session.hostId,
          fromPath: body.path,
          toSessionId: target.session.id,
          toPath: body.toPath
        }
      });

      return result.payload;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/sessions/:sessionId/close", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
      const accessFilter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);
      const session = await prisma.session.findFirst({
        where: { id: sessionId, organizationId: actor.organizationId, host: accessFilter }
      });
      if (!session) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      if (session.gatewaySessionId) {
        try {
          await fetch(`${config.gatewayBaseUrl}/sessions/${session.gatewaySessionId}/close`, {
            method: "POST",
            headers: gatewayHeaders()
          });
        } catch (gatewayError) {
          request.log.warn({ err: gatewayError }, "gateway session close failed");
        }
      }

      const updated = await prisma.session.update({
        where: { id: session.id },
        data: { status: "CLOSED", endedAt: new Date() }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: `${sessionProtocolFromPrisma[session.protocol]}.session.close`,
        targetType: "session",
        targetId: session.id,
        ipAddress: request.ip
      });

      return toRemoteSession(updated);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
