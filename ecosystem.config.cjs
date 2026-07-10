/**
 * PM2 ecosystem for onshell.cloud
 *
 * Public web UI runs on port 5016. The API and gateway are backend services
 * on their own ports (the web app talks to them).
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

const root = __dirname;
const env = process.env;

// Ports
const WEB_PORT = 5016; // public web UI (the port you run behind your proxy/domain)
const API_PORT = Number(env.API_PORT) || 4000;
const GATEWAY_PORT = Number(env.GATEWAY_PORT) || 4100;

const DATABASE_URL = env.DATABASE_URL || "mysql://onshell:onshell@localhost:3306/onshell_cloud";
const REDIS_URL = env.REDIS_URL || "redis://localhost:6379";
const CORS_ORIGINS = env.CORS_ORIGINS || `http://localhost:${WEB_PORT}`;
const PUBLIC_BASE_URL = env.PUBLIC_BASE_URL || `http://localhost:${WEB_PORT}`;
const API_BASE_URL = env.API_BASE_URL || `http://localhost:${API_PORT}`;
const GATEWAY_BASE_URL = env.GATEWAY_BASE_URL || `http://localhost:${GATEWAY_PORT}`;

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
        // NOTE: NEXT_PUBLIC_* are baked into the client bundle at `yarn build`
        // time. To change them, set them before building, then rebuild.
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
        JWT_SECRET: env.JWT_SECRET || "change-me-in-production",
        MASTER_ENCRYPTION_KEY: env.MASTER_ENCRYPTION_KEY || "replace-with-32-byte-base64-key",
        CORS_ORIGINS,
        PUBLIC_BASE_URL,
        API_BASE_URL,
        GATEWAY_BASE_URL,
        GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || "",
        GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET || "",
        GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI || `${API_BASE_URL}/auth/google/callback`,
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
      },
    },
  ],
};
