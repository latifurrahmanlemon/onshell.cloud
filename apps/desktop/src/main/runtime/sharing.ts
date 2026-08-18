/**
 * "Share this computer" — the agent tunnel, inside the app.
 *
 * The same `@onshell/agent` core the headless CLI runs, driven from this window
 * instead of from argv. Nothing about the tunnel, the pairing, the consent
 * prompts, or the local audit journal is reimplemented here; if it were, the two
 * would drift, and the one that drifted would be the one deciding who gets a
 * shell on somebody's laptop.
 *
 * This is the opposite direction from the rest of the app. Everything else is
 * *using* the workspace from this machine; this is *offering* this machine to
 * the workspace, so that a browser tab somewhere else can open a terminal here.
 * It is off until switched on, and it says so loudly while it is on.
 *
 * Pairing is a click rather than a typed code. The person is already signed in,
 * so the app mints a pairing code through the API and immediately spends it —
 * the code exists to carry authority from a browser to a program that has none,
 * and here the program already has it. See docs/agent.md.
 */
import {
  AGENT_VERSION,
  AgentTunnel,
  auditPath,
  discoverShells,
  loadAgentConfig,
  pair,
  saveAgentConfig,
  type AgentConfig,
  type ApprovalMode,
  type ResolvedShell
} from "@onshell/agent";
import { hostname } from "node:os";
import { requireApi } from "./session.js";
import { loadSettings, saveSettings } from "./settings.js";

export interface SharingState {
  /** True once this machine has been paired to a workspace. */
  paired: boolean;
  /** True while the tunnel is actually up. */
  running: boolean;
  ownerEmail?: string;
  approval: ApprovalMode;
  agentVersion: string;
  /** Where the local record of every session lives, for the machine's owner. */
  logPath: string;
}

let tunnel: AgentTunnel | null = null;
let config: AgentConfig | null = null;
let shells: ResolvedShell[] = [];

function isPaired(candidate: AgentConfig | null): candidate is AgentConfig {
  return Boolean(candidate?.deviceToken && candidate.deviceId);
}

export async function sharingState(): Promise<SharingState> {
  config ??= await loadAgentConfig();
  return {
    paired: isPaired(config),
    running: tunnel !== null,
    ownerEmail: config.ownerEmail,
    approval: config.approval,
    agentVersion: AGENT_VERSION,
    logPath: auditPath()
  };
}

/** Brings the tunnel up. Safe to call when it is already running. */
export async function startSharing(): Promise<SharingState> {
  config ??= await loadAgentConfig();
  if (tunnel || !isPaired(config)) return sharingState();

  shells = await discoverShells();
  if (shells.length === 0) {
    // Paired but with nothing to offer. Reported as "not running" rather than
    // as an error: the machine is still enrolled, it just has no shell.
    return sharingState();
  }

  tunnel = new AgentTunnel(config, shells);
  await tunnel.start();
  await saveSettings({ sharing: { enabled: true } });
  return sharingState();
}

export async function stopSharing(): Promise<SharingState> {
  tunnel?.stop();
  tunnel = null;
  await saveSettings({ sharing: { enabled: false } });
  return sharingState();
}

/**
 * Pairs this machine with the signed-in account and starts serving.
 *
 * The agent core keeps its own configuration file, deliberately separate from
 * this app's: the machine stays paired, and stays revocable by whoever is
 * sitting at it, whether or not anyone is signed in to the desktop app. Those
 * are two different relationships with two different lifetimes.
 */
export async function startSharingThisComputer(name?: string): Promise<SharingState> {
  const server = (await loadSettings()).server;
  if (!server) throw new Error("Connect to an Onshell server first.");

  const { code } = await requireApi().createAgentPairingCode();

  // The agent core reads its API and gateway URLs from its own config, so a
  // self-hosted deployment has to be written there before pairing rather than
  // left pointing at onshell.cloud.
  await saveAgentConfig({ apiBaseUrl: server.apiBaseUrl, gatewayBaseUrl: server.gatewayBaseUrl });
  await pair(code, name?.trim() || hostname());

  config = await loadAgentConfig();
  return startSharing();
}

/**
 * Who may open a session here without someone at this keyboard agreeing.
 *
 * Applied by reconnecting rather than by reaching into the running tunnel:
 * approval is read when a session opens, and a clean restart is the honest way
 * to make sure no session started under the old policy survives the change.
 */
export async function setApproval(mode: ApprovalMode): Promise<SharingState> {
  await saveAgentConfig({ approval: mode });
  config = await loadAgentConfig();
  if (tunnel) {
    tunnel.stop();
    tunnel = null;
    await startSharing();
  }
  return sharingState();
}

/**
 * Restores sharing at startup if the user had it on.
 *
 * Only when they turned it on: a remote-access tunnel must never come up on its
 * own because a config file happened to exist.
 */
export async function restoreSharing() {
  const settings = await loadSettings();
  if (!settings.sharing.enabled) return;
  config = await loadAgentConfig();
  if (isPaired(config)) await startSharing();
}

/** Stops serving. Called when the app quits, so quitting really does stop it. */
export function shutdownSharing() {
  tunnel?.stop();
  tunnel = null;
}
