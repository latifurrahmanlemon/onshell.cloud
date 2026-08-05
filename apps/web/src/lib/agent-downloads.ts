/**
 * Reads the agent download manifest that `scripts/publish-agent-downloads.mjs`
 * writes into the public folder.
 *
 * The manifest is read from disk rather than fetched over HTTP: the file is
 * already sitting next to the server, and a page that fetches its own static
 * asset fails in exactly the situation it must not — the first request after a
 * deploy, before the site is reachable under its own hostname.
 *
 * Missing is a normal state, not an error. A checkout that has never run the
 * release workflow has no downloads, and the page says so rather than throwing.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export type AgentBuild = {
  target: string;
  /** Coarse platform used for grouping and auto-detection. */
  os: "windows" | "macos" | "linux";
  osLabel: string;
  archLabel: string;
  format: "zip" | "tar.gz";
  file: string;
  /** Site-absolute URL, served straight from public/. */
  path: string;
  bytes: number;
  sha256: string;
};

export type AgentManifest = {
  version: string;
  releasedAt: string;
  commit?: string;
  builds: AgentBuild[];
  /** Every version still kept in the repository, newest first. */
  versions?: string[];
};

const MANIFEST = "downloads/agent/latest.json";

/**
 * `next start` runs with cwd at apps/web and PM2 sets the same cwd, so the
 * first candidate is the answer in production. The second covers a process
 * launched from the monorepo root, which is what `turbo` does in development.
 */
const candidates = [
  path.join(process.cwd(), "public", MANIFEST),
  path.join(process.cwd(), "apps", "web", "public", MANIFEST)
];

export async function readAgentManifest(): Promise<AgentManifest | null> {
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as AgentManifest;
      if (Array.isArray(parsed.builds) && parsed.builds.length > 0) return parsed;
    } catch {
      // Next candidate. A malformed manifest is treated as no manifest: the
      // page degrades to "not published yet", which is true enough and does not
      // take the marketing site down with it.
    }
  }
  return null;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
