import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

export function handleRouteError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "validation_failed",
      issues: error.issues
    });
  }

  if (error instanceof Error) {
    return reply.code(500).send({
      error: "internal_error",
      message: error.message
    });
  }

  return reply.code(500).send({
    error: "internal_error"
  });
}

