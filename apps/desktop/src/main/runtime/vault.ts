/**
 * Where the desktop app keeps the session.
 *
 * The refresh token is a month-long credential for the whole workspace, so it
 * goes through Electron's `safeStorage` — Keychain on macOS, DPAPI on Windows,
 * libsecret/kwallet on Linux — and lands on disk only as ciphertext that the OS
 * will decrypt for this user, on this machine, and nobody else. A JSON file next
 * to the settings would be readable by every process running as the user, which
 * for a remote-access tool is the same as publishing it.
 *
 * The access token is never persisted at all. It lives 12 hours and can be
 * re-minted from the refresh token, so writing it down would add exposure and
 * buy nothing.
 *
 * `safeStorage` is not available on every Linux desktop (no keyring daemon). We
 * refuse to fall back to plaintext: the honest failure is to make the user sign
 * in again each launch, not to quietly downgrade the storage of their session
 * while the UI still says they are signed in.
 */
import { app, safeStorage } from "electron";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TokenPair } from "@onshell/api-client";

function tokenFile() {
  return path.join(app.getPath("userData"), "session.bin");
}

/** In-memory half of the pair. Deliberately not persisted. */
let accessToken: string | undefined;
let refreshToken: string | undefined;
let loaded = false;

export function keychainAvailable() {
  return safeStorage.isEncryptionAvailable();
}

async function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  if (!keychainAvailable()) return;
  try {
    const encrypted = await readFile(tokenFile());
    const value = safeStorage.decryptString(encrypted);
    refreshToken = value || undefined;
  } catch {
    // Missing file on first run, or ciphertext this machine can no longer
    // decrypt (restored backup, new OS user, reset keychain). Both mean "no
    // session", which is a state the app already handles.
    refreshToken = undefined;
  }
}

/** The pair the API client should use, or undefined when signed out. */
export async function loadTokens(): Promise<TokenPair | undefined> {
  await loadFromDisk();
  if (!refreshToken) return undefined;
  // An empty access token is legitimate right after a restart: the client will
  // get a 401 on its first call and refresh, which is exactly the intent.
  return { accessToken: accessToken ?? "", refreshToken };
}

export async function saveTokens(tokens: TokenPair): Promise<void> {
  loaded = true;
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
  if (!keychainAvailable()) return; // Session stays in memory for this run only.

  const file = tokenFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, safeStorage.encryptString(tokens.refreshToken));
}

export async function clearTokens(): Promise<void> {
  loaded = true;
  accessToken = undefined;
  refreshToken = undefined;
  await rm(tokenFile(), { force: true });
}

export function hasSession() {
  return Boolean(refreshToken);
}
