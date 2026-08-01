/**
 * Pairing this machine with an Onshell account.
 *
 * Runs once. Someone signed in to the console issues a code, types it here, and
 * this exchanges it for a device identity that lives on this machine from then
 * on. The code is short-lived and single-use precisely because it is the one
 * step where a human carries a secret between two screens.
 */
import { arch, release } from "node:os";
import { AGENT_VERSION, loadAgentConfig, saveAgentConfig, configPath } from "./config.js";
import { defaultDeviceName, machineFingerprint } from "./machine.js";

function agentPlatform(): "win32" | "darwin" | "linux" {
  const current = process.platform;
  if (current === "win32" || current === "darwin") return current;
  return "linux";
}

export async function pair(code: string, name?: string) {
  const config = await loadAgentConfig();
  const deviceName = name?.trim() || defaultDeviceName();

  const response = await fetch(`${config.apiBaseUrl}/agents/enroll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": `onshell-agent/${AGENT_VERSION}`
    },
    body: JSON.stringify({
      code,
      name: deviceName,
      fingerprint: await machineFingerprint(),
      platform: agentPlatform(),
      arch: arch(),
      osVersion: release(),
      agentVersion: AGENT_VERSION,
      hostname: defaultDeviceName()
    })
  });

  if (response.status === 401) {
    throw new Error("That pairing code is not valid, has already been used, or has expired. Generate a new one.");
  }
  if (response.status === 429) {
    throw new Error("Too many pairing attempts. Wait a minute and try again.");
  }
  if (!response.ok) {
    throw new Error(`Pairing failed: the API responded with status ${response.status}.`);
  }

  const body = (await response.json()) as {
    deviceId?: unknown;
    deviceToken?: unknown;
    name?: unknown;
    ownerUserId?: unknown;
    ownerEmail?: unknown;
  };
  if (typeof body.deviceId !== "string" || typeof body.deviceToken !== "string") {
    throw new Error("Pairing failed: the API response was missing the device identity.");
  }

  await saveAgentConfig({
    deviceId: body.deviceId,
    deviceToken: body.deviceToken,
    apiBaseUrl: config.apiBaseUrl,
    gatewayBaseUrl: config.gatewayBaseUrl,
    // Whoever issued the pairing code becomes the machine's owner: they are
    // trusted on it, and everyone else in the workspace is not.
    ownerUserId: typeof body.ownerUserId === "string" ? body.ownerUserId : undefined,
    ownerEmail: typeof body.ownerEmail === "string" ? body.ownerEmail : undefined,
    approval: config.approval
  });

  return {
    deviceId: body.deviceId,
    name: typeof body.name === "string" ? body.name : deviceName,
    ownerEmail: typeof body.ownerEmail === "string" ? body.ownerEmail : undefined,
    storedAt: configPath()
  };
}
