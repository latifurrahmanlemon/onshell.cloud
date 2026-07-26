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
// from the backend URLs when not explicitly set, so setting only SITE_URL /
// API_BASE_URL / GATEWAY_BASE_URL in .env is enough for the frontend to target
// the right hosts.
if (!process.env.NEXT_PUBLIC_SITE_URL) {
  process.env.NEXT_PUBLIC_SITE_URL =
    process.env.SITE_URL ??
    process.env.PUBLIC_BASE_URL ??
    (process.env.NODE_ENV === "production" ? "https://onshell.cloud" : "http://localhost:3000");
}
if (!process.env.NEXT_PUBLIC_API_BASE_URL && process.env.API_BASE_URL) {
  process.env.NEXT_PUBLIC_API_BASE_URL = process.env.API_BASE_URL;
}
if (!process.env.NEXT_PUBLIC_GATEWAY_BASE_URL && process.env.GATEWAY_BASE_URL) {
  process.env.NEXT_PUBLIC_GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL;
}

// Cloudflare Turnstile's site key is fetched at runtime from the API
// (GET /public/site-config) so admins can rotate it without a rebuild. Only the
// widget script origin needs to be known at build time, hence no key here.

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@onshell/shared", "@onshell/ui"],
  // Do not advertise the framework version to attackers.
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_GATEWAY_BASE_URL: process.env.NEXT_PUBLIC_GATEWAY_BASE_URL,
  },
  async headers() {
    const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    const gatewayOrigin = process.env.NEXT_PUBLIC_GATEWAY_BASE_URL ?? "";
    // Gateway traffic is WebSocket; allow both schemes for its origin.
    const gatewaySocket = gatewayOrigin.replace(/^http/, "ws");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js injects inline bootstrap scripts; Turnstile is loaded from Cloudflare.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' data: https://fonts.gstatic.com",
              // Avatars are stored as data: URLs; blob: is used by xterm canvas.
              "img-src 'self' data: blob: https:",
              `connect-src 'self' ${apiOrigin} ${gatewayOrigin} ${gatewaySocket} https://challenges.cloudflare.com`.trim(),
              "frame-src https://challenges.cloudflare.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
