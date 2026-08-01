/**
 * Identifying this machine.
 *
 * Used so a computer that was wiped and set up again is recognised as the same
 * one, keeping its host, its access grants, and its history instead of
 * appearing twice in the customer's list.
 *
 * Not a security boundary. Every source here is readable, and on some platforms
 * writable, by the machine's own user — which is exactly the person we would be
 * defending against, and who already has a shell on it. Authentication is the
 * device token; this is bookkeeping.
 */
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, hostname, platform } from "node:os";
import { promisify } from "node:util";

const run = promisify(exec);

/**
 * Namespace for the hash.
 *
 * The raw identifier is a stable, machine-unique value that other software on
 * the same computer also reads — a Windows MachineGuid or a macOS platform
 * UUID. Hashing it with a fixed namespace means our servers store something
 * that identifies the machine to *us* without handing out a correlator anyone
 * else could match against their own records.
 */
const FINGERPRINT_NAMESPACE = "onshell.cloud/agent/fingerprint/v1";

async function rawWindowsId() {
  // The MachineGuid is written at install time and survives everything short of
  // a reinstall, which is precisely the lifetime we want.
  const { stdout } = await run('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid');
  return /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(stdout)?.[1];
}

async function rawDarwinId() {
  const { stdout } = await run("ioreg -rd1 -c IOPlatformExpertDevice");
  return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1];
}

async function rawLinuxId() {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = (await readFile(path, "utf8")).trim();
      if (id.length > 0) return id;
    } catch {
      // Try the next location.
    }
  }

  return undefined;
}

async function rawMachineId() {
  try {
    switch (platform()) {
      case "win32":
        return await rawWindowsId();
      case "darwin":
        return await rawDarwinId();
      default:
        return await rawLinuxId();
    }
  } catch {
    // A locked-down machine may refuse the registry read or the ioreg call.
    return undefined;
  }
}

/**
 * A stable per-machine identifier.
 *
 * Falls back to hostname and platform when the real identifier is unavailable.
 * That is weaker — two identically named machines in one organization would
 * collide, and renaming a machine makes it look new — but the consequence is a
 * duplicate row in a list, not a security failure, and it beats refusing to
 * enrol.
 */
export async function machineFingerprint() {
  const raw = (await rawMachineId()) ?? `fallback:${hostname()}:${platform()}:${arch()}`;
  return createHash("sha256").update(`${FINGERPRINT_NAMESPACE}:${raw}`).digest("hex");
}

/** What the machine calls itself, offered as the default device name. */
export function defaultDeviceName() {
  return hostname();
}
