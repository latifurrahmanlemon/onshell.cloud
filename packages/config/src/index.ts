export type ServiceName = "api" | "gateway" | "web";

export interface RuntimeConfig {
  service: ServiceName;
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  publicBaseUrl: string;
  apiBaseUrl: string;
  gatewayBaseUrl: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  masterEncryptionKey: string;
  corsOrigins: string[];
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  guacdHost: string;
  guacdPort: number;
}

const defaultPorts: Record<ServiceName, number> = {
  api: 4000,
  gateway: 4100,
  web: 3000
};

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

export function loadConfig(service: ServiceName): RuntimeConfig {
  return {
    service,
    nodeEnv: env("NODE_ENV", "development"),
    host: env("HOST", "0.0.0.0"),
    port: envNumber("PORT", defaultPorts[service]),
    logLevel: env("LOG_LEVEL", "info"),
    publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:3000"),
    apiBaseUrl: env("API_BASE_URL", "http://localhost:4000"),
    gatewayBaseUrl: env("GATEWAY_BASE_URL", "http://localhost:4100"),
    databaseUrl: env("DATABASE_URL", "mysql://onshell:onshell@localhost:3306/onshell_cloud"),
    redisUrl: env("REDIS_URL", "redis://localhost:6379"),
    jwtSecret: env("JWT_SECRET", "development-only-change-me"),
    masterEncryptionKey: env("MASTER_ENCRYPTION_KEY", "development-only-change-me"),
    corsOrigins: envList("CORS_ORIGINS", ["http://localhost:3000"]),
    googleClientId: env("GOOGLE_CLIENT_ID"),
    googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
    googleRedirectUri: env("GOOGLE_REDIRECT_URI", `${env("API_BASE_URL", "http://localhost:4000")}/auth/google/callback`),
    guacdHost: env("GUACD_HOST", "localhost"),
    guacdPort: envNumber("GUACD_PORT", 4822)
  };
}
