import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the repo-root .env so the web app picks up config regardless of the
// directory Next.js is launched from (dev runs from apps/web; Next only
// auto-loads apps/web/.env*, not the monorepo root). Existing shell env always
// wins so PM2 / CI overrides are respected.
function loadRootEnv() {
  const rootEnv = path.resolve(__dirname, "../../.env");
  if (!fs.existsSync(rootEnv)) return;
  for (let line of fs.readFileSync(rootEnv, "utf8").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadRootEnv();

// NEXT_PUBLIC_* are inlined into the client bundle at build time. Derive them
// from the backend URLs when not explicitly set, so setting only API_BASE_URL /
// GATEWAY_BASE_URL in .env is enough for the frontend to target the right host.
if (!process.env.NEXT_PUBLIC_API_BASE_URL && process.env.API_BASE_URL) {
  process.env.NEXT_PUBLIC_API_BASE_URL = process.env.API_BASE_URL;
}
if (!process.env.NEXT_PUBLIC_GATEWAY_BASE_URL && process.env.GATEWAY_BASE_URL) {
  process.env.NEXT_PUBLIC_GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@onshell/shared", "@onshell/ui"],
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_GATEWAY_BASE_URL: process.env.NEXT_PUBLIC_GATEWAY_BASE_URL,
  },
};

export default nextConfig;
