/**
 * Types and pure helpers for the agent download manifest.
 *
 * This module is deliberately free of Node built-ins so it can be imported from
 * a Client Component. The disk read that produces a manifest lives in
 * `agent-downloads.ts`, which imports `node:fs`; pulling that into the browser
 * bundle is what fails the build with an "Unhandled scheme" error on `node:`.
 */

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

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
