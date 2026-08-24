import type { FastifyError } from "fastify";

/**
 * How a thrown error becomes a client response.
 *
 * This lives here rather than inline in `main.ts` because `main.ts` binds a port
 * on import, so nothing in it can be exercised from a test — and the one rule
 * below that a client depends on is exactly the one that was silently wrong.
 */

/** The slice of @fastify/rate-limit's `errorResponseBuilder` context we use. */
interface RateLimitContext {
  /** 429. Optional only so a plugin that omits it cannot resurrect the 500. */
  statusCode?: number;
  /** Milliseconds until the limit resets. */
  ttl: number;
}

export interface ErrorResponse {
  status: number;
  body: Record<string, unknown>;
  /** Whether this is a server fault, and so belongs in the log. */
  logAsFault: boolean;
}

/**
 * The 429 body for a rate-limited request.
 *
 * @fastify/rate-limit *throws* whatever `errorResponseBuilder` returns, so this
 * reaches `resolveErrorResponse` instead of the client. A plain object carried
 * no `statusCode`, which read as an unhandled fault and answered
 * `500 internal_error` — discarding both the 429 and the retry hint that the web
 * and desktop clients are written against. Hence an `Error`, with the status on
 * it.
 */
export function buildRateLimitError(context: RateLimitContext): FastifyError {
  const retryAfterSeconds = Math.ceil(context.ttl / 1000);
  return Object.assign(new Error(`Too many requests. Try again in ${retryAfterSeconds}s.`), {
    statusCode: context.statusCode ?? 429,
    code: "rate_limited",
    retryAfterSeconds
  });
}

/**
 * Maps an error onto a status and body.
 *
 * Internal failures deliberately return only `internal_error`: the message can
 * carry connection strings, SQL fragments, or filesystem paths, so it goes to
 * the log and never to the client.
 */
export function resolveErrorResponse(error: FastifyError): ErrorResponse {
  if (error.validation) {
    return { status: 400, body: { error: "validation_failed" }, logAsFault: false };
  }

  const status = error.statusCode ?? 500;
  if (status >= 500) {
    return { status: 500, body: { error: "internal_error" }, logAsFault: true };
  }

  // The retry hint is the one field a client cannot work out for itself, so it
  // has to survive the generic mapping below.
  const { retryAfterSeconds } = error as FastifyError & { retryAfterSeconds?: number };
  if (retryAfterSeconds !== undefined) {
    return {
      status,
      body: { error: error.code ?? "rate_limited", message: error.message, retryAfterSeconds },
      logAsFault: false
    };
  }

  return {
    status,
    body: { error: error.code ?? "request_failed", message: error.message },
    logAsFault: false
  };
}
