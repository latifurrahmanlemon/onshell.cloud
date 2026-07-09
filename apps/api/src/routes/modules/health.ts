import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";

export async function registerHealthRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.get("/health", async () => ({
    status: "ok",
    service: "api",
    project: "Onshell.cloud",
    version: "0.1.0"
  }));

  app.get("/ready", async () => ({
    status: "ready",
    dependencies: {
      database: config.databaseUrl ? "configured" : "missing",
      redis: config.redisUrl ? "configured" : "missing",
      gateway: config.gatewayBaseUrl
    }
  }));
}

