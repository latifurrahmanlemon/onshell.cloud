/**
 * This copy of the app, as a machine the workspace knows about.
 *
 * Enrolment exists for one reason: direct connections put decrypted credential
 * material on this computer, and "which machines have been handed material, and
 * can I cut one off" has to be answerable afterwards. It is not what authorises
 * a lease — the signed-in user's own host access is — so it is deliberately not
 * presented as a security checkpoint it is not.
 *
 * The enrolment secret is a long-lived credential and goes in the OS keychain
 * beside the session, never in settings.json. The fingerprint is not a secret:
 * it is a random id generated once so that reinstalling the app updates the
 * existing device row instead of growing a new one every launch.
 */
import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSettings, saveSettings } from "./settings.js";
import { requireApi } from "./session.js";

export interface EnrolledDevice {
  id: string;
  name: string;
}

function secretFile() {
  return path.join(app.getPath("userData"), "device.bin");
}

let cachedSecret: string | undefined;
let cachedDevice: EnrolledDevice | undefined;
let inFlight: Promise<string | undefined> | null = null;

async function readSecret(): Promise<string | undefined> {
  if (cachedSecret) return cachedSecret;
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    cachedSecret = safeStorage.decryptString(await readFile(secretFile())) || undefined;
  } catch {
    cachedSecret = undefined;
  }
  return cachedSecret;
}

async function writeSecret(secret: string) {
  cachedSecret = secret;
  if (!safeStorage.isEncryptionAvailable()) return; // Held for this run only.
  const file = secretFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, safeStorage.encryptString(secret));
}

/** Stable per-install id. Generated once and kept in plain settings. */
async function fingerprint() {
  const settings = await loadSettings();
  if (settings.deviceFingerprint) return settings.deviceFingerprint;
  const value = randomUUID();
  await saveSettings({ deviceFingerprint: value });
  return value;
}

/**
 * Enrols if needed and returns the secret to present with a lease request.
 *
 * Concurrent callers share one enrolment: two terminals opened at the same
 * moment on a fresh install would otherwise both register, and the second would
 * rotate the secret out from under the first.
 */
export async function deviceSecret(): Promise<string | undefined> {
  const existing = await readSecret();
  if (existing) return existing;

  inFlight ??= (async () => {
    try {
      const response = await requireApi().transport.request<{
        device: EnrolledDevice;
        secret: string;
      }>("/desktop/devices", {
        method: "POST",
        body: JSON.stringify({
          name: hostname(),
          fingerprint: await fingerprint(),
          platform: process.platform,
          appVersion: app.getVersion()
        })
      });
      cachedDevice = response.device;
      await writeSecret(response.secret);
      return response.secret;
    } catch {
      // A machine that cannot enrol simply has no direct mode; the caller falls
      // back to the relay rather than failing the terminal outright.
      return undefined;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function enrolledDevice() {
  return cachedDevice;
}

/**
 * Forgets this machine's enrolment locally. Called on sign-out: the secret
 * belongs to the account that created it, and the next account on this computer
 * must enrol as its own device.
 */
export async function forgetDevice() {
  cachedSecret = undefined;
  cachedDevice = undefined;
  await rm(secretFile(), { force: true });
}
