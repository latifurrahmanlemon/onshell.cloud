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
