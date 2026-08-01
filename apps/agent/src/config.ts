/**
 * Where the agent keeps its identity between runs.
 *
 * Phase 1 stores the device token in a `0600` file under the OS config
 * directory. That is deliberately temporary: the token is a long-lived
 * credential for shell access to this machine, so it belongs in the OS
 * credential store — DPAPI/Credential Manager, Keychain, libsecret — which is
 * the first thing enrollment (phase 2) moves it into. Until then the agent is
 * developer-only and says so on startup.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { isApprovalMode, type ApprovalMode } from "./consent.js";

export const AGENT_VERSION = "0.1.0";

/**
 * Where a freshly installed agent looks, before anyone has told it otherwise.
 *
 * One constant, because the API and the gateway sit behind path prefixes on the
 * same host (`/api` and `/gateway`) rather than on subdomains — see
 * docs/deploy-cloudpanel.md. An agent shipped to a customer has no environment
 * and no config file yet, so if these are wrong, `onshell-agent pair` fails
 * before it can be told anything.
 */
const PRODUCTION_SITE_URL = "https://onshell.cloud";

export interface AgentConfig {
  apiBaseUrl: string;
  gatewayBaseUrl: string;
  /** Assigned by the API at enrollment. */
  deviceId?: string;
  /** Long-lived; exchanged for a short-lived connection token on every connect. */
  deviceToken?: string;
  /**
   * The account that paired this machine, trusted on it under the default
   * policy. Everyone else has to be let in by whoever is sitting here.
   */
  ownerUserId?: string;
  ownerEmail?: string;
  /**
   * Who may start a session without someone at this keyboard agreeing.
   *
   * Lives here rather than on the server on purpose: a consent setting the
   * workspace admin could flip is not consent. Changing it means having access
   * to this machine, which is the same thing as being the person it protects.
   */
  approval: ApprovalMode;
}

interface StoredConfig {
  deviceId?: string;
  deviceToken?: string;
  apiBaseUrl?: string;
  gatewayBaseUrl?: string;
  ownerUserId?: string;
  ownerEmail?: string;
  approval?: string;
}

export function configDirectory() {
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Onshell");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Onshell");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "onshell");
  }
}

export function configPath() {
  return join(configDirectory(), "agent.json");
}

async function readStored(): Promise<StoredConfig> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as StoredConfig;
  } catch {
    // Absent or unreadable is the normal state before enrollment.
    return {};
  }
}

export async function loadAgentConfig(): Promise<AgentConfig> {
  const stored = await readStored();

  // Environment wins over the file so a developer can point one machine at a
  // local gateway without editing (and later re-committing) stored state.
  return {
    apiBaseUrl: process.env.ONSHELL_API_URL ?? stored.apiBaseUrl ?? `${PRODUCTION_SITE_URL}/api`,
    gatewayBaseUrl: process.env.ONSHELL_GATEWAY_URL ?? stored.gatewayBaseUrl ?? `${PRODUCTION_SITE_URL}/gateway`,
    deviceId: process.env.ONSHELL_DEVICE_ID ?? stored.deviceId,
    deviceToken: process.env.ONSHELL_DEVICE_TOKEN ?? stored.deviceToken,
    ownerUserId: stored.ownerUserId,
    ownerEmail: stored.ownerEmail,
    // Unrecognised values fall back to the safe mode rather than being trusted,
    // so a typo in a hand-edited config cannot silently disable the prompt.
    // The environment can override it — for a managed fleet, or a machine with
    // no desktop to show a dialog on — and the startup banner always prints the
    // mode in force, so this cannot be set behind the owner's back.
    approval: isApprovalMode(process.env.ONSHELL_APPROVAL)
      ? process.env.ONSHELL_APPROVAL
      : isApprovalMode(stored.approval)
        ? stored.approval
        : "ask"
  };
}

export async function saveAgentConfig(patch: StoredConfig) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });

  const next = { ...(await readStored()), ...patch };
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode applies only when creating; an existing file keeps its
  // old permissions, so tighten explicitly every time.
  await chmod(path, 0o600).catch(() => undefined);
}
