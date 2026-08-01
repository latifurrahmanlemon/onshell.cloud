/**
 * Enrolling and managing machines that run the Onshell Agent.
 *
 * Three of these routes are unusual for this service: `/agents/enroll` and
 * `/agents/token` carry no user session at all. Their caller is a program on
 * somebody's laptop, and the credential *is* the request body — a pairing code
 * a human just typed, or the device token issued in exchange for one. Both are
 * rate-limited accordingly.
 *
 * See docs/agent.md.
 */
import { randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { signAgentToken, AGENT_TOKEN_TTL_SECONDS } from "@onshell/agent-protocol";
import { canManageHosts, type AgentDevice } from "@onshell/shared";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { allowAgent, disconnectAgent, fetchOnlineAgents, type OnlineAgent } from "../../lib/gateway.js";
import { prisma } from "../../lib/prisma.js";
import { recordAudit } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";
import { hashToken } from "../../lib/token.js";

/**
 * Pairing-code alphabet, minus the characters people mistype when reading a
 * code off one screen and into another: I/1, O/0, and the ambiguous 5/S pair is
 * kept only as S. 32 symbols over 8 characters is 40 bits, which is only safe
 * because the code dies in ten minutes, works once, and is rate-limited.
 */
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

const rateLimit = (max: number, timeWindow = "1 minute") => ({ config: { rateLimit: { max, timeWindow } } });

function generatePairingCode() {
  let code = "";
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  // Grouped for reading aloud; normalised away again on the way back in.
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accepts whatever the user typed: spaces, dashes, and lower case all fine. */
function normalizePairingCode(raw: string) {
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

const pairingCodeSchema = z.string().min(1).max(32);

const enrollSchema = z.object({
  code: pairingCodeSchema,
  name: z.string().trim().min(1).max(120),
  fingerprint: z.string().min(1).max(255),
  platform: z.enum(["win32", "darwin", "linux"]),
  arch: z.string().min(1).max(32),
  osVersion: z.string().max(200).optional(),
  agentVersion: z.string().max(32).optional(),
  hostname: z.string().max(255).optional()
});

const tokenSchema = z.object({
  deviceId: z.string().min(1).max(64),
  deviceToken: z.string().min(1).max(512)
});

const deviceParamsSchema = z.object({ deviceId: z.string().min(1).max(64) });

type DeviceRow = Awaited<ReturnType<typeof prisma.agentDevice.findFirstOrThrow>>;

function toAgentDevice(device: DeviceRow, connected: OnlineAgent | undefined): AgentDevice {
  return {
    id: device.id,
    organizationId: device.organizationId,
    hostId: device.hostId,
    name: device.name,
    platform: device.platform,
    arch: device.arch,
    osVersion: device.osVersion ?? undefined,
    // Prefer what the live connection reports: a machine that auto-updated is
    // running a newer agent than the row remembers from enrolment.
    agentVersion: connected?.agentVersion ?? device.agentVersion ?? undefined,
    hostname: device.hostname ?? undefined,
    online: connected !== undefined,
    shells: connected?.shells ?? [],
    lastSeenAt: device.lastSeenAt?.toISOString(),
    revokedAt: device.revokedAt?.toISOString(),
    enrolledById: device.enrolledById ?? undefined,
    createdAt: device.createdAt.toISOString(),
    updatedAt: device.updatedAt.toISOString()
  };
}

export async function registerAgentRoutes(app: FastifyInstance, config: RuntimeConfig) {
  /**
   * Issues a pairing code. Shown once — only its hash is stored.
   */
  app.post("/agents/pairing-codes", rateLimit(10), async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      // Enrolling a machine adds a host anyone with access could get a shell on,
      // so it needs the same permission as creating one by hand.
      if (!canManageHosts(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const code = generatePairingCode();
      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
      await prisma.agentPairingCode.create({
        data: {
          organizationId: actor.organizationId,
          createdById: actor.id,
          codeHash: hashToken(normalizePairingCode(code)),
          expiresAt
        }
      });

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "agent.pairing_code.created",
        targetType: "organization",
        targetId: actor.organizationId,
        ipAddress: request.ip
      });

      return { code, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * Exchanges a pairing code for a device identity.
   *
   * Unauthenticated: the caller is an agent on a machine that has no account
   * and no session. The code is the whole credential, which is why it is
   * consumed inside the same transaction that creates the device — two agents
   * racing on one code must not both end up enrolled.
   */
  app.post("/agents/enroll", rateLimit(10), async (request, reply) => {
    try {
      const body = enrollSchema.parse(request.body);
      const codeHash = hashToken(normalizePairingCode(body.code));

      const pairing = await prisma.agentPairingCode.findUnique({ where: { codeHash } });
      if (!pairing || pairing.consumedAt || pairing.expiresAt < new Date()) {
        return reply.code(401).send({ error: "invalid_pairing_code" });
      }

      const deviceToken = randomBytes(48).toString("base64url");
      const tokenHash = hashToken(deviceToken);

      const device = await prisma.$transaction(async (tx) => {
        // Consuming with a guard on `consumedAt` makes the race a lost update
        // rather than a second enrolment: whoever gets here first wins.
        const consumed = await tx.agentPairingCode.updateMany({
          where: { id: pairing.id, consumedAt: null },
          data: { consumedAt: new Date() }
        });
        if (consumed.count === 0) throw new PairingCodeAlreadyUsedError();

        // A machine that was wiped and set up again keeps its host, its access
        // grants, and its history instead of appearing twice in the list.
        const existing = await tx.agentDevice.findUnique({
          where: {
            organizationId_fingerprint: {
              organizationId: pairing.organizationId,
              fingerprint: body.fingerprint
            }
          }
        });

        if (existing) {
          return tx.agentDevice.update({
            where: { id: existing.id },
            data: {
              name: body.name,
              platform: body.platform,
              arch: body.arch,
              osVersion: body.osVersion,
              agentVersion: body.agentVersion,
              hostname: body.hostname,
              tokenHash,
              // Re-pairing is an explicit act by someone who could already see
              // the code, so it clears a previous revocation.
              revokedAt: null,
              enrolledById: pairing.createdById
            }
          });
        }

        const host = await tx.host.create({
          data: {
            organizationId: pairing.organizationId,
            name: body.name,
            type: "AGENT",
            // Nothing ever dials these; the machine is already connected to us.
            // Recorded for display only, so the hosts table has something sane.
            address: body.hostname ?? body.name,
            port: 0,
            environment: "DEVELOPMENT",
            isAgent: true,
            health: "online",
            notes: "Reached through the Onshell Agent running on this machine. No credential required."
          },
          select: { id: true }
        });

        return tx.agentDevice.create({
          data: {
            organizationId: pairing.organizationId,
            hostId: host.id,
            name: body.name,
            fingerprint: body.fingerprint,
            platform: body.platform,
            arch: body.arch,
            osVersion: body.osVersion,
            agentVersion: body.agentVersion,
            hostname: body.hostname,
            tokenHash,
            enrolledById: pairing.createdById
          }
        });
      });

      // A machine paired again after being revoked is still on the gateway's
      // short denial list; clear it so it can connect straight away.
      await allowAgent(device.id);

      await recordAudit({
        organizationId: device.organizationId,
        actorId: pairing.createdById,
        action: "agent.enrolled",
        targetType: "agent_device",
        targetId: device.id,
        ipAddress: request.ip,
        metadata: { name: device.name, platform: device.platform, hostId: device.hostId }
      });

      // The owner travels back so the agent knows who to trust without asking:
      // whoever issued the code can reach this machine unattended, and everyone
      // else needs someone at its keyboard to agree.
      const owner = await prisma.user.findUnique({
        where: { id: pairing.createdById },
        select: { id: true, email: true }
      });

      return reply.code(201).send({
        deviceId: device.id,
        deviceToken,
        name: device.name,
        ownerUserId: owner?.id,
        ownerEmail: owner?.email
      });
    } catch (error) {
      if (error instanceof PairingCodeAlreadyUsedError) {
        return reply.code(401).send({ error: "invalid_pairing_code" });
      }
      return handleRouteError(reply, error);
    }
  });

  /**
   * Exchanges the long-lived device token for a short-lived gateway token.
   *
   * The reason this indirection exists: the gateway has no database, so it
   * authenticates agents by verifying a signature. Minting that signature here
   * means the device token never reaches the gateway, and revoking a device
   * takes effect on the next refresh regardless of what the gateway believes.
   *
   * The limit is generous because a flapping network makes an agent reconnect
   * repeatedly and legitimately; it exists to bound brute force, not to police
   * reconnects.
   */
  app.post("/agents/token", rateLimit(60), async (request, reply) => {
    try {
      const body = tokenSchema.parse(request.body);

      // Looked up *by hash*, so a wrong token finds nothing and no comparison
      // happens at all — there is no secret-dependent branch to time.
      const device = await prisma.agentDevice.findUnique({ where: { tokenHash: hashToken(body.deviceToken) } });
      if (!device || device.id !== body.deviceId) {
        return reply.code(401).send({ error: "invalid_device_token" });
      }
      if (device.revokedAt) {
        return reply.code(403).send({ error: "device_revoked" });
      }

      await prisma.agentDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

      return {
        token: signAgentToken({ sub: device.id, organizationId: device.organizationId }, config.jwtSecret),
        expiresIn: AGENT_TOKEN_TTL_SECONDS
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/agents", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const [devices, online] = await Promise.all([
        prisma.agentDevice.findMany({
          where: { organizationId: actor.organizationId },
          orderBy: { createdAt: "desc" }
        }),
        fetchOnlineAgents(actor.organizationId)
      ]);

      return devices.map((device) => toAgentDevice(device, online.get(device.id)));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * Withdraws a machine's access without forgetting it happened.
   *
   * The row and its host stay so the audit trail still names the machine that
   * was reachable; only the ability to connect goes away.
   */
  app.post("/agents/:deviceId/revoke", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const { deviceId } = deviceParamsSchema.parse(request.params);
      const device = await prisma.agentDevice.findFirst({
        where: { id: deviceId, organizationId: actor.organizationId }
      });
      if (!device) return reply.code(404).send({ error: "not_found" });

      const updated = await prisma.agentDevice.update({
        where: { id: device.id },
        data: {
          revokedAt: new Date(),
          // Rotating the hash means the token on that machine is dead even if
          // the row is later un-revoked by hand.
          tokenHash: hashToken(randomBytes(48).toString("base64url")),
          host: { update: { health: "offline" } }
        }
      });

      // Ends the tunnel and every terminal on it now, instead of leaving them
      // alive until the agent's short-lived token happens to expire.
      await disconnectAgent(device.id, "access revoked");

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "agent.revoked",
        targetType: "agent_device",
        targetId: device.id,
        ipAddress: request.ip,
        metadata: { name: device.name }
      });

      return toAgentDevice(updated, undefined);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /** Removes the machine and its host entirely. */
  app.delete("/agents/:deviceId", async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });
      if (!canManageHosts(actor.role)) return reply.code(403).send({ error: "forbidden" });

      const { deviceId } = deviceParamsSchema.parse(request.params);
      const device = await prisma.agentDevice.findFirst({
        where: { id: deviceId, organizationId: actor.organizationId }
      });
      if (!device) return reply.code(404).send({ error: "not_found" });

      // The device row cascades from the host, so one delete covers both.
      await prisma.host.delete({ where: { id: device.hostId } });
      await disconnectAgent(device.id, "this machine was removed");

      await recordAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "agent.deleted",
        targetType: "agent_device",
        targetId: device.id,
        ipAddress: request.ip,
        metadata: { name: device.name }
      });

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });
}

/** Thrown inside the enrol transaction when another agent consumed the code first. */
class PairingCodeAlreadyUsedError extends Error {
  constructor() {
    super("pairing code already used");
    this.name = "PairingCodeAlreadyUsedError";
  }
}
