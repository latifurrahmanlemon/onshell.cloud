/**
 * Agent transport — a shell on the *customer's own machine*, reached through
 * the tunnel that machine holds open to us.
 *
 * Not to be confused with protocols/local.ts, which is a shell on the machine
 * the gateway itself runs on. The two look similar from routes.ts on purpose:
 * both hand back something shaped like a `LocalShell`, so the terminal
 * WebSocket handler does not care which kind of session it is serving.
 */
import { randomBytes } from "node:crypto";
import { LOCAL_TICKET_TTL_MS, type Requester } from "@onshell/agent-protocol";
import { createGatewaySession, updateGatewaySession, type GatewaySession } from "../registry.js";
import {
  AgentFileError,
  AgentUnavailableError,
  getDevice,
  type AgentDevice,
  type AgentShell
} from "../agents/registry.js";

export interface OpenAgentSessionInput {
  hostId: string;
  deviceId: string;
  /** Token from the agent's advertised list. Omitted means that agent's default. */
  shell?: string;
  startPath?: string;
  /** Who is asking, so the machine can log it and decide whether to allow it. */
  requestedBy?: Requester;
}

const shells = new Map<string, AgentShell>();

/**
 * Asks the machine whether this session may happen at all.
 *
 * Nothing is created before it answers. The agent applies the policy its owner
 * set — which may mean putting a dialog in front of whoever is sitting at that
 * computer — so a refusal here is a person saying no, not a failure.
 */
async function authorize(device: AgentDevice, kind: "shell" | "files", requestedBy?: Requester) {
  try {
    await device.rpc("session.open", { kind, requestedBy });
  } catch (error) {
    if (error instanceof AgentFileError) throw new AgentUnavailableError(error.code);
    throw error;
  }
}

/**
 * Offers the browser a direct connection, when one is possible.
 *
 * Only ever called *after* the session was authorised, which is what makes the
 * ticket safe to hand out: the loopback listener authenticates on the ticket
 * alone, so it must never exist for a session the machine's owner has not
 * already agreed to.
 *
 * Best-effort throughout. An agent with no listener, or one that refuses the
 * call, simply gets no ticket and the session uses the tunnel.
 */
async function offerLocalRoute(device: AgentDevice, shell?: string, cwd?: string) {
  const port = device.info.localPort;
  if (port === undefined) return undefined;

  const ticket = randomBytes(32).toString("base64url");
  try {
    await device.rpc("local.expect", { ticket, shell, cwd, expiresInMs: LOCAL_TICKET_TTL_MS });
  } catch {
    return undefined;
  }

  return { ticket, port, expiresInMs: LOCAL_TICKET_TTL_MS };
}

export async function openAgentSession(input: OpenAgentSessionInput): Promise<GatewaySession> {
  const device = getDevice(input.deviceId);
  // Checked here rather than at WebSocket-connect time so the API can answer
  // "that machine is offline" while the user is still looking at the host list,
  // instead of opening a terminal that dies a second later.
  if (!device?.online) throw new AgentUnavailableError("agent_offline");

  await authorize(device, "shell", input.requestedBy);
  const local = await offerLocalRoute(device, input.shell, input.startPath);

  const session = createGatewaySession({
    protocol: "ssh",
    hostId: input.hostId,
    websocketPath: "",
    metadata: {
      transport: "agent",
      deviceId: input.deviceId,
      shell: input.shell,
      startPath: input.startPath,
      // The gateway never dials anything for this transport; the address field
      // exists so session listings stay uniform across transports.
      address: device.info.hostname ?? input.deviceId,
      // A browser on the same machine may use these instead of the tunnel. It
      // verifies the device id first and falls back silently if anything about
      // the loopback route does not work — see docs/agent.md.
      localTicket: local?.ticket,
      localPort: local?.port
    }
  });

  return updateGatewaySession(session.id, {
    status: "active",
    websocketPath: `/ws/ssh/${session.id}`
  }) as GatewaySession;
}

/**
 * A file session on an enrolled machine.
 *
 * Nothing is opened here: the file routes create a transport per operation, and
 * that transport is a thin wrapper over RPCs on a tunnel that already exists.
 */
export async function openAgentFileSession(input: OpenAgentSessionInput): Promise<GatewaySession> {
  const device = getDevice(input.deviceId);
  if (!device?.online) throw new AgentUnavailableError("agent_offline");

  await authorize(device, "files", input.requestedBy);

  const session = createGatewaySession({
    protocol: "sftp",
    hostId: input.hostId,
    metadata: {
      transport: "agent",
      deviceId: input.deviceId,
      startPath: input.startPath,
      address: device.info.hostname ?? input.deviceId
    }
  });

  return updateGatewaySession(session.id, { status: "active" }) as GatewaySession;
}

/**
 * Starts the terminal for an agent session.
 *
 * Resolved on first WebSocket connect rather than at session-open time, so a
 * session nobody connects to never spawns a process on someone's laptop.
 */
export async function openAgentShell(
  session: GatewaySession,
  size?: { columns: number; rows: number }
): Promise<AgentShell> {
  const existing = shells.get(session.id);
  if (existing) return existing;

  const deviceId = typeof session.metadata?.deviceId === "string" ? session.metadata.deviceId : undefined;
  if (!deviceId) throw new AgentUnavailableError("agent_session_missing_device");

  const device = getDevice(deviceId);
  if (!device?.online) throw new AgentUnavailableError("agent_offline");

  const shell = await device.openShell({
    shell: typeof session.metadata?.shell === "string" ? session.metadata.shell : undefined,
    cols: size?.columns ?? 80,
    rows: size?.rows ?? 24,
    cwd: typeof session.metadata?.startPath === "string" ? session.metadata.startPath : undefined
  });

  shells.set(session.id, shell);
  shell.onExit(() => {
    shells.delete(session.id);
    updateGatewaySession(session.id, { status: "closed" });
  });

  return shell;
}

export function closeAgentShell(sessionId: string) {
  const shell = shells.get(sessionId);
  if (!shell) return;
  shell.end();
  shells.delete(sessionId);
}
