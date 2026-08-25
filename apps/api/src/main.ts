import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyError } from "fastify";
import { loadConfig } from "@onshell/config";
import { buildRateLimitError, resolveErrorResponse } from "./lib/error-response.js";
import { registerRoutes } from "./routes/index.js";

const config = loadConfig("api");

const app = Fastify({
  logger: {
    level: config.logLevel,
    // Never log credentials or session cookies, even at debug level.
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "req.body.password",
      "req.body.newPassword",
      "req.body.currentPassword",
      "req.body.secretKey",
      "req.body.apiKey",
      "req.body.webhookSecret",
      "req.body.turnstileToken"
    ]
  },
  // Behind Nginx/Cloudflare, X-Forwarded-For carries the real client IP, which
  // rate limiting and audit logging both depend on. Off by default in dev so a
  // spoofed header cannot forge an IP when there is no trusted proxy in front.
  trustProxy: config.trustProxy,
  // Cap request bodies. The largest legitimate payload is a base64 avatar
  // (~1.5MB), so 2MB leaves headroom without inviting memory-exhaustion.
  bodyLimit: 2 * 1024 * 1024,
  // Do not echo a client-supplied request id into logs/responses unvalidated.
  requestIdHeader: false
});

await app.register(helmet, {
  // The API serves JSON only; a restrictive CSP costs nothing and blocks any
  // accidentally reflected markup from executing.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: "same-site" },
  referrerPolicy: { policy: "no-referrer" },
  hsts: config.cookieSecure ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false
});

await app.register(cookie, {
  secret: config.jwtSecret
});

await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
  // Key on the (proxy-aware) client IP and return a machine-readable body.
  keyGenerator: (request) => request.ip,
  // The plugin *throws* whatever this returns, so it lands in the error handler
  // below rather than being sent as written — buildRateLimitError explains why
  // that has to be an Error carrying the status.
  errorResponseBuilder: (_request, context) => buildRateLimitError(context)
});

await app.register(cors, {
  credentials: true,
  origin: config.corsOrigins,
  // PUT is here for the file editor (PUT /sessions/:id/files/content). Leaving a
  // verb out of this list makes the browser block the request after a successful
  // preflight, which surfaces as an opaque client-side failure and nothing at all
  // in the server log — keep it in step with the routes that actually exist.
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 86_400
});

await app.register(sensible);

// Uncaught route errors must not leak internals (stack traces, SQL, paths) to
// clients. handleRouteError covers the routes that catch; this covers the rest.
app.setErrorHandler((error: FastifyError, request, reply) => {
  const { status, body, logAsFault } = resolveErrorResponse(error);
  if (logAsFault) {
    request.log.error({ err: error }, "Unhandled request error");
  }
  return reply.code(status).send(body);
});

app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "not_found" }));

await registerRoutes(app, config);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
