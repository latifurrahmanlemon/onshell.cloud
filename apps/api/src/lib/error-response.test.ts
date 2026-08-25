import { describe, expect, it } from "vitest";
import type { FastifyError } from "fastify";
import { buildRateLimitError, resolveErrorResponse } from "./error-response.js";

/**
 * Regression cover for a bug that made every rate limit in the product lie.
 *
 * @fastify/rate-limit throws whatever `errorResponseBuilder` returns, so the body
 * it built arrived at the error handler rather than at the client. The builder
 * returned a bare object; a bare object has no `statusCode`; the handler read
 * that as an unhandled fault and answered `500 {"error":"internal_error"}` with
 * the retry hint discarded. A throttled client was told the server had broken,
 * and the "try again in Ns" copy in apps/web (`mapErrorCode`) and apps/desktop
 * (`describeAuthFailure`) could never appear.
 */

/** A thrown error shaped the way Fastify hands one to the error handler. */
function fastifyError(overrides: Record<string, unknown> = {}): FastifyError {
  return Object.assign(new Error("boom"), { code: "unknown" }, overrides) as unknown as FastifyError;
}

describe("a rate-limited request", () => {
  it("answers 429 with the code and retry hint the clients read", () => {
    // 34.5s left on the window, which the hint rounds up.
    const thrown = buildRateLimitError({ statusCode: 429, ttl: 34_500 });

    expect(resolveErrorResponse(thrown)).toEqual({
      status: 429,
      body: {
        error: "rate_limited",
        message: "Too many requests. Try again in 35s.",
        retryAfterSeconds: 35
      },
      logAsFault: false
    });
  });

  it("carries the status on the thrown value, which is what the old body lacked", () => {
    // The root cause in one assertion: the handler can only avoid the 500 if the
    // status survives being thrown.
    expect(buildRateLimitError({ statusCode: 429, ttl: 1_000 }).statusCode).toBe(429);
  });

  it("still answers 429 when the plugin hands over no status", () => {
    // Falling back to 500 here is the exact failure being fixed, so the default
    // is a 429 rather than whatever the handler assumes.
    expect(resolveErrorResponse(buildRateLimitError({ ttl: 1_000 })).status).toBe(429);
  });

  it("is not logged as a server fault", () => {
    // It filled the log with "Unhandled request error" for a limit doing exactly
    // what it was configured to do.
    const response = resolveErrorResponse(buildRateLimitError({ statusCode: 429, ttl: 1_000 }));

    expect(response.logAsFault).toBe(false);
  });
});

describe("other errors", () => {
  it("reports a schema failure as a bad request", () => {
    const response = resolveErrorResponse(
      fastifyError({ statusCode: 400, validation: [{ keyword: "type", instancePath: "/email" }] })
    );

    expect(response).toEqual({ status: 400, body: { error: "validation_failed" }, logAsFault: false });
  });

  it("tells the client nothing about an internal failure, and logs it", () => {
    const response = resolveErrorResponse(fastifyError({ message: "connect ECONNREFUSED 10.0.0.4:3306" }));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error" });
    // The host and port above are exactly what must not reach the client.
    expect(JSON.stringify(response.body)).not.toContain("10.0.0.4");
    expect(response.logAsFault).toBe(true);
  });

  it("passes a client error's own code and message through", () => {
    const response = resolveErrorResponse(
      fastifyError({ statusCode: 413, code: "payload_too_large", message: "Body is too large." })
    );

    expect(response).toEqual({
      status: 413,
      body: { error: "payload_too_large", message: "Body is too large." },
      logAsFault: false
    });
  });

  it("keeps a retry hint from any source, not just the rate limiter", () => {
    // The per-account login lock in auth.ts sends its 429 directly, but anything
    // that throws one instead must not lose the hint on the way out.
    const response = resolveErrorResponse(
      fastifyError({ statusCode: 429, code: "too_many_login_attempts", retryAfterSeconds: 60 })
    );

    expect(response.body).toMatchObject({ error: "too_many_login_attempts", retryAfterSeconds: 60 });
  });
});
