import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { loadConfig } from "@onshell/config";
import { registerGatewayRoutes } from "./routes.js";

const config = loadConfig("gateway");
const app = Fastify({
  logger: {
    level: config.logLevel
  }
});

await app.register(helmet);
await app.register(cors, {
  credentials: true,
  origin: config.corsOrigins
});
await app.register(websocket);
await registerGatewayRoutes(app, config);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

