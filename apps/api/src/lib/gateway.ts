/**
 * Talking to the gateway service.
 *
 * The gateway holds no database and no notion of users; it knows which agents
 * currently have a socket open and nothing else. So "is this machine online?"
 * is a question only it can answer, and one this service has to ask rather than
 * store — a `status` column would be stale the moment a laptop closed its lid.
 */
import { loadConfig } from "@onshell/config";
import type { AgentShellOption } from "@onshell/shared";
import { prisma } from "./prisma.js";

const config = loadConfig("api");

export function gatewayHeaders() {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sharedSecret = process.env.GATEWAY_SHARED_SECRET;
  if (sharedSecret) headers.authorization = `Bearer ${sharedSecret}`;
  return headers;
}

/** One row of the gateway's `GET /agents`. */
interface GatewayAgent {
  deviceId: string;
  organizationId: string;
  online: boolean;
  connectedAt?: string;
  platform?: string;
  arch?: string;
  osVersion?: string;
  hostname?: string;
  agentVersion?: string;
  shells?: AgentShellOption[];
  terminals?: number;
}

export interface OnlineAgent {
  connectedAt?: string;
  shells: AgentShellOption[];
  agentVersion?: string;
  terminals: number;
}

/**
 * Drops an agent's tunnel now, rather than waiting for its token to expire.
 *
 * Best-effort by design: the database is the authority on whether a device may
 * connect, and a revoked device fails its next token refresh regardless. This
 * closes the window in between, and a gateway that cannot be reached must not
 * turn a successful revocation into a failed request.
 */
export async function disconnectAgent(deviceId: string, reason: string) {
  try {
    await fetch(`${config.gatewayBaseUrl}/agents/${encodeURIComponent(deviceId)}/disconnect`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: JSON.stringify({ reason })
    });
  } catch {
    // Revocation still stands; the agent loses access at its next refresh.
  }
}

/**
 * The gateway session ids that are still running, out of whatever `GET /sessions`
 * answered with.
 *
 * Separate from the call, and strict about what it accepts, because the caller
 * turns this list into "close everything not in it". A response that is not an
 * array of sessions has to be distinguishable from an array of none — the second
 * closes every session in the workspace and the first must close nothing — so
 * this returns undefined rather than an empty list when it cannot read the shape.
 * Entries without a string id are dropped for the same reason they cannot help:
 * no row could ever match them.
 */
export function liveGatewaySessionIds(payload: unknown): string[] | undefined {
  if (!Array.isArray(payload)) return undefined;

  return payload
    .filter((session): session is { id?: unknown; status?: unknown } => typeof session === "object" && session !== null)
    .filter((session) => session.status !== "closed" && session.status !== "failed")
    .map((session) => session.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Closes the session rows whose shells the gateway no longer has.
 *
 * A `Session` row is only ever marked closed by someone calling
 * `POST /sessions/:id/close` — which the console does on its close button, and
 * which nothing does when a browser is simply quit, crashes, or is closed from
 * the operating system. Those rows stayed `ACTIVE` for good, and because the
 * plan's concurrency limit counts exactly them, a workspace that had opened
 * enough terminals over its lifetime would eventually be unable to open any at
 * all: `concurrent_session_limit_reached`, permanently, with no session actually
 * running anywhere.
 *
 * The gateway is the authority here, in the same way it is for whether a machine
 * is online: it either holds a live shell for that id or it does not, and a
 * database column cannot know. A gateway restart therefore closes everything,
 * which is correct — a restart really does end every session it was serving.
 *
 * Nothing is closed if the gateway cannot be reached or answers badly. An
 * unreachable gateway means "no information", and reading it as "no sessions"
 * would end the terminals of everyone who is working, over a network blip.
 *
 * Single-node assumption, shared with `fetchOnlineAgents` above: this asks the
 * one gateway what it has. A second node would make this a Redis lookup, and
 * until then it must not be given one — a per-node answer would close the other
 * node's live sessions.
 */
export async function reconcileSessions(organizationId: string) {
  let liveIds: string[];

  try {
    const response = await fetch(`${config.gatewayBaseUrl}/sessions`, { headers: gatewayHeaders() });
    if (!response.ok) return;

    const parsed = liveGatewaySessionIds(await response.json());
    // Not an array is not an empty array — a gateway answering something this
    // service does not understand has told it nothing.
    if (!parsed) return;
    liveIds = parsed;
  } catch {
    // No answer is not the same as an empty answer. Leave the rows alone.
    return;
  }

  try {
    await prisma.session.updateMany({
      where: {
        organizationId,
        status: { in: ["PENDING", "ACTIVE"] },
        // Only rows that name a gateway session, because only those can be
        // checked against one. Nothing creates a row without an id — it is
        // written in the same `create` as the row itself, after the gateway has
        // already answered — so this excludes nothing real, and it means a
        // session being opened right now cannot be closed by a reconcile racing
        // it.
        //
        // The empty case is spelled out rather than left to `notIn: []`, whose
        // meaning is a convention of the query builder and not something this
        // should depend on. A gateway holding nothing means every one of these
        // rows is stale, which is the case that matters most: it is exactly what
        // a restarted gateway looks like.
        gatewaySessionId: liveIds.length > 0 ? { not: null, notIn: liveIds } : { not: null }
      },
      data: { status: "CLOSED", endedAt: new Date() }
    });
  } catch {
    // Best-effort tidying. A failure here must not turn into a failed request
    // for the caller that happened to trigger it.
  }
}

/** Clears a gateway-side denial after a machine has been paired again. */
export async function allowAgent(deviceId: string) {
  try {
    await fetch(`${config.gatewayBaseUrl}/agents/${encodeURIComponent(deviceId)}/allow`, {
      method: "POST",
      headers: gatewayHeaders()
    });
  } catch {
    // The denial ages out on its own within one token lifetime.
  }
}

/**
 * Which devices are connected right now, keyed by device id.
 *
 * A gateway that cannot be reached yields an empty map rather than an error:
 * the device list is still worth rendering with everything shown as offline,
 * which is both true from the user's point of view and more useful than a page
 * that fails to load.
 */
export async function fetchOnlineAgents(organizationId: string): Promise<Map<string, OnlineAgent>> {
  const online = new Map<string, OnlineAgent>();

  try {
    const response = await fetch(`${config.gatewayBaseUrl}/agents`, { headers: gatewayHeaders() });
    if (!response.ok) return online;

    const agents = (await response.json()) as GatewayAgent[];
    for (const agent of agents) {
      // The gateway serves every organization, so filter here. Callers use this
      // to decide what to show a specific customer.
      if (!agent.online || agent.organizationId !== organizationId) continue;
      online.set(agent.deviceId, {
        connectedAt: agent.connectedAt,
        shells: agent.shells ?? [],
        agentVersion: agent.agentVersion,
        terminals: agent.terminals ?? 0
      });
    }
  } catch {
    // Unreachable gateway is reported as "everything offline".
  }

  return online;
}
