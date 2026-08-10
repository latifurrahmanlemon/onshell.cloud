/**
 * PM2 ecosystem for onshell.cloud
 *
 * Public web UI runs on port 5018. The API and gateway are backend services
 * on their own ports (the web app talks to them).
 *
 * DNS + Nginx for the domain (see docs/deployment.md):
 *   A/AAAA  onshell.cloud      -> server
 *   CNAME   www.onshell.cloud  -> onshell.cloud
 *
 *   One host; Nginx routes /api and /gateway to the two services below.
 *
 *   Prereqs (run once):
 *     yarn install
 *     yarn build          # builds packages + apps (creates the dist folders and apps/web/.next)
 *     yarn db:deploy      # apply MySQL migrations
 *     yarn db:seed        # seed admin/plans/settings
 *
 *   Start:
 *     pm2 start ecosystem.config.cjs
 *     pm2 logs
 *     pm2 save             # persist across reboots (after `pm2 startup`)
 *
 * Env values below fall back to sensible dev defaults. In production, export the
 * real values before `pm2 start` (they are read here at start time), e.g.:
 *     set -a && source .env && pm2 start ecosystem.config.cjs
 * or edit the values in this file.
 */
const path = require("path");
const fs = require("fs");

const root = __dirname;

// Load repo-root .env so `pm2 start ecosystem.config.cjs` gets secrets even
// without `source .env`. Existing shell env always wins (does not override).
(() => {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (let line of fs.readFileSync(envPath, "utf8").split("\n")) {
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
})();

const env = process.env;

// Ports (env can override; defaults match the production CloudPanel deploy)
const WEB_PORT = Number(env.WEB_PORT) || 5018; // public web UI (behind Nginx/domain)
const API_PORT = Number(env.API_PORT) || 5017;
const GATEWAY_PORT = Number(env.GATEWAY_PORT) || 5019;

const DATABASE_URL = env.DATABASE_URL || "mysql://onshell:onshell@localhost:3306/onshell_cloud";
const REDIS_URL = env.REDIS_URL || "redis://localhost:6379";

// Public domain. Nginx terminates TLS for onshell.cloud and reverse-proxies by
// path to the local ports above:
//   onshell.cloud/          -> 127.0.0.1:WEB_PORT
//   onshell.cloud/api/      -> 127.0.0.1:API_PORT
//   onshell.cloud/gateway/  -> 127.0.0.1:GATEWAY_PORT   (WebSocket upgrade)
const SITE_URL = env.SITE_URL || "https://onshell.cloud";
const PUBLIC_BASE_URL = env.PUBLIC_BASE_URL || SITE_URL;
const API_BASE_URL = env.API_BASE_URL || `${SITE_URL}/api`;
const GATEWAY_BASE_URL = env.GATEWAY_BASE_URL || `${SITE_URL}/gateway`;
const CORS_ORIGINS = env.CORS_ORIGINS || `${SITE_URL},https://www.onshell.cloud`;
const COOKIE_DOMAIN = env.COOKIE_DOMAIN || ".onshell.cloud";

const common = {
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  max_memory_restart: "512M",
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "onshell-web",
      cwd: path.join(root, "apps/web"),
      // Run the Next.js production server directly so the port is explicit.
      script: path.join(root, "node_modules/next/dist/bin/next"),
      args: `start -p ${WEB_PORT}`,
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: WEB_PORT,
        SITE_URL,
        // NOTE: NEXT_PUBLIC_* are baked into the client bundle at `yarn build`
        // time. To change them, set them before building, then rebuild.
        NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL || SITE_URL,
        NEXT_PUBLIC_API_BASE_URL: env.NEXT_PUBLIC_API_BASE_URL || API_BASE_URL,
        NEXT_PUBLIC_GATEWAY_BASE_URL: env.NEXT_PUBLIC_GATEWAY_BASE_URL || GATEWAY_BASE_URL,
      },
    },
    {
      ...common,
      name: "onshell-api",
      cwd: path.join(root, "apps/api"),
      script: "dist/main.js",
      env: {
        NODE_ENV: "production",
        HOST: env.HOST || "0.0.0.0",
        PORT: API_PORT,
        LOG_LEVEL: env.LOG_LEVEL || "info",
        DATABASE_URL,
        REDIS_URL,
        // No placeholder fallbacks: the API refuses to boot in production with
        // the example secrets, so a missing value fails loudly at start rather
        // than silently running with a forgeable JWT key.
        JWT_SECRET: env.JWT_SECRET || "",
        MASTER_ENCRYPTION_KEY: env.MASTER_ENCRYPTION_KEY || "",
        CORS_ORIGINS,
        SITE_URL,
        PUBLIC_BASE_URL,
        API_BASE_URL,
        GATEWAY_BASE_URL,
        COOKIE_DOMAIN,
        // Left unset on purpose: the API then marks the session cookie Secure
        // based on the actual request scheme. Forcing "true" here would make the
        // browser silently discard the cookie whenever the site is reached over
        // http:// (before TLS is set up, or via the server's IP), which presents
        // as a failed login even though the password was correct.
        COOKIE_SECURE: env.COOKIE_SECURE || "",
        TRUST_PROXY: env.TRUST_PROXY || "true",
        GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || "",
        GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET || "",
        GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI || `${API_BASE_URL}/auth/google/callback`,
        CONTACT_NOTIFY_EMAIL: env.CONTACT_NOTIFY_EMAIL || "support@onshell.cloud",
        // Shared with the gateway process below. Left empty when unset rather
        // than defaulted: a hardcoded fallback would be the same on every
        // deployment, which is no better than no secret at all.
        GATEWAY_SHARED_SECRET: env.GATEWAY_SHARED_SECRET || "",
        // Lockout escape hatch only — see .env.example. Bot protection itself is
        // configured from /admin.
        TURNSTILE_DISABLED: env.TURNSTILE_DISABLED || "false",
      },
    },
    {
      ...common,
      name: "onshell-gateway",
      cwd: path.join(root, "apps/gateway"),
      script: "dist/main.js",
      env: {
        NODE_ENV: "production",
        HOST: env.HOST || "0.0.0.0",
        PORT: GATEWAY_PORT,
        LOG_LEVEL: env.LOG_LEVEL || "info",
        REDIS_URL,
        CORS_ORIGINS,
        GATEWAY_BASE_URL,
        GUACD_HOST: env.GUACD_HOST || "localhost",
        GUACD_PORT: env.GUACD_PORT || "4822",
        // Must match the API's value; when set, the gateway's REST routes stop
        // answering unauthenticated callers.
        GATEWAY_SHARED_SECRET: env.GATEWAY_SHARED_SECRET || "",
      },
    },
  ],
};
