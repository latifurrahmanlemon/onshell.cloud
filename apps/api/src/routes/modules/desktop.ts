/**
 * The desktop app's two extra needs: being a known machine, and getting a
 * credential it can dial a host with.
 *
 * Everything else the app does goes through the same routes the browser console
 * uses. What is different is that a native client can open a TCP connection, so
 * it does not need us to hold the SSH session for it — and the price of that is
 * that the credential has to reach the user's machine.
 *
 * That is the whole security question in this file, so it is worth stating what
 * a lease is and is not. It is *not* a new authorisation: it is only ever issued
 * for a host the caller could already open a relayed shell on, using the same
 * role check, the same per-host grant, and the same plan limits. What it changes
 * is where the plaintext lives — the user's own machine instead of the gateway
 * — and who is on the wire between them and their server, which is nobody.
 *
 * What bounds it: sixty seconds, one host, one session, an enrolled and
 * unrevoked device, a workspace that has not turned direct connections off, and
 * an audit row naming the machine. Enrolment is not what authorises the lease —
 * the user's own access is — but it is what makes the handout visible
 * afterwards and revocable one machine at a time.
 *
 * See docs/desktop.md.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { canOpenSession } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { decryptSecret } from "../../lib/encryption.js";
import { accessibleHostFilter } from "../../lib/host-access.js";
import { prisma } from "../../lib/prisma.js";
import { recordAudit } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";
import { hashToken } from "../../lib/token.js";

const rateLimit = (max: number, timeWindow = "1 minute") => ({ config: { rateLimit: { max, timeWindow } } });

/**
 * How long a lease is good for.
 *
 * Long enough to open a TCP connection and finish an SSH handshake over a slow
 * link; far too short to be worth capturing and replaying later. It is a launch
 * token, not a copy of the vault.
 */
const LEASE_TTL_SECONDS = 60;

const enrollSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fingerprint: z.string().min(1).max(255),
  platform: z.enum(["win32", "darwin", "linux"]),
  appVersion: z.string().max(32).optional()
});

const leaseSchema = z.object({
  hostId: z.string().min(1).max(64),
  credentialId: z.string().min(1).max(64).optional(),
  protocol: z.enum(["ssh", "sftp"]).default("ssh")
});

const deviceParamsSchema = z.object({ deviceId: z.string().min(1).max(64) });

type DeviceRow = Awaited<ReturnType<typeof prisma.desktopDevice.findFirstOrThrow>>;

/** The device as the console and the app see it. Never includes the secret. */
function toDesktopDevice(device: DeviceRow) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    appVersion: device.appVersion ?? undefined,
    lastSeenAt: device.lastSeenAt?.toISOString(),
    revokedAt: device.revokedAt?.toISOString(),
    createdAt: device.createdAt.toISOString()
  };
}

export async function registerDesktopRoutes(app: FastifyInstance, config: RuntimeConfig) {
  /**
   * Registers this copy of the app, or re-registers it after a reinstall.
   *
   * Idempotent on (user, fingerprint) so launching the app twice does not grow
   * the device list, and the secret is rotated each time — the old one stops
   * working, which is the right outcome when a machine has been reimaged.
   *
   * A previously revoked device is *not* silently reinstated: the owner cut it
   * off deliberately, and enrolment is authenticated by a session that may be
   * the very thing they were cutting off.
   */
  app.post("/desktop/devices", rateLimit(10), async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const body = enrollSchema.parse(request.body);
      const existing = await prisma.desktopDevice.findUnique({
        where: { userId_fingerprint: { userId: actor.id, fingerprint: body.fingerprint } }
      });
      if (existing?.revokedAt) {
        return reply.code(403).send({
          error: "device_revoked",
          message: "This machine's access was revoked. Restore it from the console first."
        });
      }

      const secret = randomBytes(32).toString("base64url");
      const device = await prisma.desktopDevice.upsert({
        where: { userId_fingerprint: { userId: actor.id, fingerprint: body.fingerprint } },
        create: {
          organizationId: actor.organizationId,
          userId: actor.id,
          name: body.name,
          fingerprint: body.fingerprint,
          platform: body.platform,
          appVersion: body.appVersion,
          secretHash: hashToken(secret),
          lastSeenAt: new Date()
        },
        update: {
          name: body.name,
          platform: body.platform,
          appVersion: body.appVersion,
          secretHash: hashToken(secret),
          lastSeenAt: new Date()
        }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "desktop.device.enroll",
        targetType: "desktop_device",
        targetId: device.id,
        ipAddress: request.ip,
        metadata: { name: device.name, platform: device.platform, reenrolled: existing !== null }
      });

      // The secret is returned exactly once. Only its hash is stored, so a
      // database read cannot recover it and neither can we.
      return reply.code(201).send({ device: toDesktopDevice(device), secret });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * The caller's own machines.
   *
   * Deliberately not the whole organisation's: this is the list a person uses to
   * recognise and cut off their own laptop. Cross-member visibility belongs in
   * the audit log, which already records every lease with its device id.
   */
  app.get("/desktop/devices", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const devices = await prisma.desktopDevice.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" }
      });
      return reply.send({ devices: devices.map(toDesktopDevice) });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /** Cuts a machine off. The row stays, so the audit trail still names it. */
  app.post("/desktop/devices/:deviceId/revoke", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const { deviceId } = deviceParamsSchema.parse(request.params);
      const device = await prisma.desktopDevice.findFirst({ where: { id: deviceId, userId: actor.id } });
      if (!device) return reply.code(404).send({ error: "device_not_found" });

      const revoked = await prisma.desktopDevice.update({
        where: { id: device.id },
        data: { revokedAt: device.revokedAt ?? new Date() }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "desktop.device.revoke",
        targetType: "desktop_device",
        targetId: device.id,
        ipAddress: request.ip,
        metadata: { name: device.name }
      });

      return reply.send({ device: toDesktopDevice(revoked) });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * Issues credential material for one direct connection.
   *
   * The order of the checks below is the security argument, so it is worth
   * following: role, then the per-host grant, then the workspace's direct-connect
   * policy, then the device — and only then is anything decrypted. Nothing is
   * read out of the vault until every reason to refuse has been exhausted.
   */
  app.post("/desktop/leases", rateLimit(30), async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canOpenSession(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const body = leaseSchema.parse(request.body);

      // The device proves itself with the secret from enrolment, not with the id
      // alone: an id is a name, and a name is not a credential.
      const presented = request.headers["x-onshell-device-secret"];
      if (typeof presented !== "string" || presented.length === 0) {
        return reply.code(401).send({ error: "device_secret_required" });
      }
      const device = await prisma.desktopDevice.findFirst({
        where: { secretHash: hashToken(presented), userId: actor.id }
      });
      if (!device) return reply.code(401).send({ error: "device_not_enrolled" });
      if (device.revokedAt) {
        return reply.code(403).send({
          error: "device_revoked",
          message: "This machine's access to credentials was revoked."
        });
      }

      const organization = await prisma.organization.findUnique({
        where: { id: actor.organizationId },
        select: { allowDirectConnect: true }
      });
      if (!organization?.allowDirectConnect) {
        return reply.code(403).send({
          error: "direct_connect_disabled",
          message: "This workspace requires sessions to go through the Onshell gateway."
        });
      }

      // The same filter the relayed path uses. Direct mode must never be a way
      // around a host grant, so the access question is asked identically.
      const accessFilter = await accessibleHostFilter(actor.id, actor.role, actor.organizationId);
      const host = await prisma.host.findFirst({
        where: { ...accessFilter, id: body.hostId },
        include: { credentials: { orderBy: { createdAt: "asc" }, take: 1 } }
      });
      if (!host) {
        const inOrganization = await prisma.host.count({
          where: { id: body.hostId, organizationId: actor.organizationId }
        });
        return inOrganization > 0
          ? reply.code(403).send({ error: "host_access_denied" })
          : reply.code(404).send({ error: "host_not_found" });
      }

      // Hosts with no address to dial. The local host is the gateway's own
      // machine and an agent host is reached down a tunnel the gateway holds —
      // neither is something this machine can connect to, and pretending
      // otherwise would produce a confusing connection failure instead of an
      // explanation.
      if (host.isLocal || host.isAgent) {
        return reply.code(400).send({
          error: "host_not_directly_reachable",
          message: host.isAgent
            ? "That machine is reached through its own tunnel, so it has to go through the gateway."
            : "The built-in local host runs on the server, so it has to go through the gateway."
        });
      }

      const credential = body.credentialId
        ? await prisma.credential.findFirst({
            where: { id: body.credentialId, organizationId: actor.organizationId },
            include: { sshKey: true }
          })
        : await prisma.credential.findFirst({
            where: { id: host.credentials[0]?.id ?? "" },
            include: { sshKey: true }
          });
      if (!credential) {
        return body.credentialId
          ? reply.code(404).send({ error: "credential_not_found" })
          : reply.code(400).send({ error: "no_credential_for_host" });
      }

      const subscription = await prisma.subscription.findFirst({
        where: { organizationId: actor.organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
        include: { plan: true },
        orderBy: { createdAt: "desc" }
      });
      const maxConcurrentSessions = subscription?.plan.maxConcurrentSessions;
      if (maxConcurrentSessions != null) {
        const activeSessions = await prisma.session.count({
          where: { organizationId: actor.organizationId, status: { in: ["PENDING", "ACTIVE"] } }
        });
        if (activeSessions >= maxConcurrentSessions) {
          return reply.code(403).send({ error: "concurrent_session_limit_reached", limit: maxConcurrentSessions });
        }
      }

      // A session row for a connection this service will never see the bytes of.
      // It exists so the workspace's session list, concurrency limits, and audit
      // trail cover direct connections exactly as they cover relayed ones — an
      // invisible session would be worse than no feature.
      const session = await prisma.session.create({
        data: {
          organizationId: actor.organizationId,
          hostId: host.id,
          userId: actor.id,
          protocol: body.protocol === "sftp" ? "SFTP" : "SSH",
          status: "PENDING"
        }
      });

      const secret = decryptSecret(
        {
          encryptedPayload: credential.encryptedPayload,
          nonce: credential.nonce,
          authTag: credential.authTag
        },
        config.masterEncryptionKey
      );

      void prisma.credential
        .update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
      void prisma.desktopDevice
        .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: `${body.protocol}.session.open`,
        targetType: "host",
        targetId: host.id,
        ipAddress: request.ip,
        // `mode` is the field an operator filters on to answer "which sessions
        // did we not see the bytes of", and the device id says from where.
        metadata: {
          sessionId: session.id,
          credentialId: credential.id,
          mode: "direct",
          deviceId: device.id,
          deviceName: device.name
        }
      });

      return reply.code(201).send({
        sessionId: session.id,
        host: {
          address: host.address,
          port: host.port,
          username: host.username ?? undefined
        },
        credential: {
          kind: credential.kind === "SSH_KEY" ? ("privateKey" as const) : ("password" as const),
          material: secret,
          // The vault stores a hint, never the passphrase itself, so an
          // encrypted key still needs one thing only the person has. The app
          // shows the hint and asks; nothing about that reaches this service.
          passphraseHint: credential.sshKey?.passphraseHint ?? undefined
        },
        expiresAt: new Date(Date.now() + LEASE_TTL_SECONDS * 1000).toISOString()
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * What happened to a direct session.
   *
   * The server is not on the wire, so it cannot observe the connection opening,
   * failing, or ending — the app has to say. Best-effort by nature: an app that
   * crashes never reports, which is why sessions also age out.
   */
  app.post("/desktop/sessions/:sessionId/state", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const { sessionId } = z.object({ sessionId: z.string().min(1).max(64) }).parse(request.params);
      const { state, reason } = z
        .object({ state: z.enum(["opened", "failed", "closed"]), reason: z.string().max(500).optional() })
        .parse(request.body);

      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId: actor.id, organizationId: actor.organizationId }
      });
      if (!session) return reply.code(404).send({ error: "session_not_found" });

      await prisma.session.update({
        where: { id: session.id },
        data: {
          status: state === "opened" ? "ACTIVE" : state === "failed" ? "FAILED" : "CLOSED",
          endedAt: state === "opened" ? null : new Date()
        }
      });

      if (state !== "opened") {
        await recordAudit({
          organizationId: actor.organizationId,
          actorId: actor.id,
          action: state === "failed" ? "ssh.session.failed" : "ssh.session.close",
          targetType: "host",
          targetId: session.hostId,
          ipAddress: request.ip,
          metadata: { sessionId: session.id, mode: "direct", reason }
        });
      }

      return reply.send({ ok: true });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}
