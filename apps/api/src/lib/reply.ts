import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

/** Prisma error codes worth translating into a specific client response. */
const PRISMA_UNIQUE_VIOLATION = "P2002";
const PRISMA_RECORD_NOT_FOUND = "P2025";

function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Turns a thrown error into a client response.
 *
 * Internal failures deliberately return only `internal_error` — the underlying
 * message can carry connection strings, SQL fragments, or filesystem paths, so
 * it goes to the server log and never to the client.
 */
export function handleRouteError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "validation_failed",
      issues: error.issues
    });
  }

  const code = prismaErrorCode(error);
  if (code === PRISMA_UNIQUE_VIOLATION) {
    return reply.code(409).send({ error: "already_exists" });
  }
  if (code === PRISMA_RECORD_NOT_FOUND) {
    return reply.code(404).send({ error: "not_found" });
  }

  reply.log.error({ err: error }, "Unhandled route error");
  return reply.code(500).send({ error: "internal_error" });
}
