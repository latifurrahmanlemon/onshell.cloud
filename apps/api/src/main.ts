import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { loadConfig } from "@onshell/config";
import { registerRoutes } from "./routes/index.js";

const config = loadConfig("api");

const app = Fastify({
  logger: {
    level: config.logLevel
  }
});

await app.register(helmet);
await app.register(cookie, {
  secret: config.jwtSecret
});
await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute"
});
await app.register(cors, {
  credentials: true,
  origin: config.corsOrigins
});
await app.register(sensible);
await registerRoutes(app, config);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
