export type ServiceName = "api" | "gateway" | "web";

export interface RuntimeConfig {
  service: ServiceName;
  nodeEnv: string;
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: string;
  /** Canonical public origin used for SEO, emails, and OAuth redirects. */
  siteUrl: string;
  publicBaseUrl: string;
  apiBaseUrl: string;
  gatewayBaseUrl: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  masterEncryptionKey: string;
  corsOrigins: string[];
  /** Cookie `Domain` attribute, e.g. `.onshell.cloud`, so the API subdomain and the site share a session. */
  cookieDomain?: string;
  /**
   * Only set when COOKIE_SECURE was given explicitly. Left undefined so the
   * request's own scheme decides — a `Secure` cookie is silently dropped over
   * plain HTTP, which is exactly what happens while TLS is still being set up.
   */
  cookieSecure?: boolean;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  guacdHost: string;
  guacdPort: number;
  /** Requests behind Nginx/Cloudflare need X-Forwarded-* honoured for correct client IPs. */
  trustProxy: boolean;
  /**
   * Whether workspaces get a shell on **the machine Onshell itself runs on**.
   *
   * Read that again before switching it on. This is not the visitor's computer —
   * a web page cannot open a shell on the machine you are browsing from. It is
   * the gateway's own host, so on a shared deployment enabling this hands every
   * account that signs up a shell on your server, all of them the same server,
   * with the gateway process's privileges.
   *
   * Off by default. Only sensible for a single-tenant or self-hosted install
   * where the operator and the only user are the same person.
   */
  localShellEnabled: boolean;
}

const defaultPorts: Record<ServiceName, number> = {
  api: 4000,
  gateway: 4100,
  web: 3000
};

/**
 * Production defaults, used when the environment does not say otherwise.
 *
 * One host with path prefixes rather than three subdomains: that is what the
 * deployment actually runs (see docs/deploy-cloudpanel.md), and defaults that
 * disagree with the deployment are worse than no defaults — they fail late, in
 * production, with a DNS error nobody expected.
 */
const PRODUCTION_SITE_URL = "https://onshell.cloud";
const PRODUCTION_API_URL = "https://onshell.cloud/api";
const PRODUCTION_GATEWAY_URL = "https://onshell.cloud/gateway";

/**
 * Placeholder secrets that ship in `.env.example`. Booting production with any
 * of these means every JWT is forgeable and every vault entry is decryptable by
 * anyone with the repo, so the process refuses to start instead.
 */
const INSECURE_SECRETS = new Set([
  "",
  "change-me",
  "change-me-in-development",
  "change-me-in-production",
  "development-only-change-me",
  "replace-with-32-byte-base64-key",
  "replace-with-a-long-random-string"
]);

function env(name: string, fallback = "") {
  return process.env[name] ?? fallback;
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envList(name: string, fallback: string[]) {
  const raw = process.env[name];
  if (!raw) return fallback;

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function envBoolean(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Distinguishes "not set" from "set to false", which a default would erase. */
function optionalBoolean(name: string) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Derives the registrable domain so one cookie covers `onshell.cloud`,
 * `www.onshell.cloud`, and any future subdomain. Returns undefined for
 * localhost and bare IPs, where a `Domain` attribute would break the cookie.
 */
function deriveCookieDomain(siteUrl: string) {
  const explicit = env("COOKIE_DOMAIN");
  if (explicit) return explicit;

  let hostname: string;
  try {
    hostname = new URL(siteUrl).hostname;
  } catch {
    return undefined;
  }

  if (hostname === "localhost" || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return undefined;

  const labels = hostname.split(".");
  if (labels.length < 2) return undefined;
  return `.${labels.slice(-2).join(".")}`;
}

function assertProductionSecrets(config: RuntimeConfig) {
  if (!config.isProduction || config.service === "web") return;

  const problems: string[] = [];
  if (INSECURE_SECRETS.has(config.jwtSecret)) problems.push("JWT_SECRET");
  else if (config.jwtSecret.length < 32) problems.push("JWT_SECRET (needs at least 32 characters)");

  if (INSECURE_SECRETS.has(config.masterEncryptionKey)) problems.push("MASTER_ENCRYPTION_KEY");
  else if (config.masterEncryptionKey.length < 32) {
    problems.push("MASTER_ENCRYPTION_KEY (needs at least 32 characters)");
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with placeholder secrets: ${problems.join(", ")}. ` +
        "Generate real values (e.g. `openssl rand -base64 48`) and set them in the environment."
    );
  }
}

export function loadConfig(service: ServiceName): RuntimeConfig {
  const isProduction = env("NODE_ENV", "development") === "production";
  const siteUrl = env("SITE_URL", isProduction ? PRODUCTION_SITE_URL : "http://localhost:3000").replace(/\/+$/, "");
  const publicBaseUrl = env("PUBLIC_BASE_URL", siteUrl).replace(/\/+$/, "");
  const apiBaseUrl = env(
    "API_BASE_URL",
    isProduction ? PRODUCTION_API_URL : "http://localhost:4000"
  ).replace(/\/+$/, "");
  const gatewayBaseUrl = env(
    "GATEWAY_BASE_URL",
    isProduction ? PRODUCTION_GATEWAY_URL : "http://localhost:4100"
  ).replace(/\/+$/, "");

  const config: RuntimeConfig = {
    service,
    nodeEnv: env("NODE_ENV", "development"),
    isProduction,
    host: env("HOST", "0.0.0.0"),
    port: envNumber("PORT", defaultPorts[service]),
    logLevel: env("LOG_LEVEL", "info"),
    siteUrl,
    publicBaseUrl,
    apiBaseUrl,
    gatewayBaseUrl,
    databaseUrl: env("DATABASE_URL", "mysql://onshell:onshell@localhost:3306/onshell_cloud"),
    redisUrl: env("REDIS_URL", "redis://localhost:6379"),
    jwtSecret: env("JWT_SECRET", "development-only-change-me"),
    masterEncryptionKey: env("MASTER_ENCRYPTION_KEY", "development-only-change-me"),
    corsOrigins: envList(
      "CORS_ORIGINS",
      isProduction ? [PRODUCTION_SITE_URL, `https://www.${PRODUCTION_SITE_URL.replace("https://", "")}`] : ["http://localhost:3000"]
    ),
    cookieDomain: deriveCookieDomain(publicBaseUrl),
    cookieSecure: optionalBoolean("COOKIE_SECURE"),
    googleClientId: env("GOOGLE_CLIENT_ID"),
    googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
    googleRedirectUri: env("GOOGLE_REDIRECT_URI", `${apiBaseUrl}/auth/google/callback`),
    guacdHost: env("GUACD_HOST", "localhost"),
    guacdPort: envNumber("GUACD_PORT", 4822),
    trustProxy: envBoolean("TRUST_PROXY", isProduction),
    localShellEnabled: envBoolean("LOCAL_SHELL_ENABLED", false)
  };

  assertProductionSecrets(config);
  return config;
}
