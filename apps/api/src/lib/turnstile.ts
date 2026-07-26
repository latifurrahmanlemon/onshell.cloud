import type { FastifyRequest } from "fastify";
import type { TurnstileSetting } from "@prisma/client";
import { decryptSecret } from "./encryption.js";
import { prisma } from "./prisma.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;

/** The public forms Turnstile can guard, each independently toggleable. */
export type TurnstileForm = "signup" | "login" | "passwordReset" | "contact" | "checkout" | "newsletter";

const formToColumn: Record<TurnstileForm, keyof TurnstileSetting> = {
  signup: "protectSignup",
  login: "protectLogin",
  passwordReset: "protectPasswordReset",
  contact: "protectContact",
  checkout: "protectCheckout",
  newsletter: "protectNewsletter"
};

export interface TurnstileVerification {
  /** False only when the challenge was required and did not pass. */
  ok: boolean;
  /** Machine-readable reason when `ok` is false. */
  error?: "captcha_required" | "captcha_failed" | "captcha_unavailable";
  /** Cloudflare's own error codes, for the server log only. */
  codes?: string[];
}

/**
 * Reads the singleton settings row. Returns null when Turnstile has never been
 * configured, which callers treat as "not enabled".
 */
export async function getTurnstileSetting() {
  return prisma.turnstileSetting.findUnique({ where: { id: "global" } });
}

/** The browser-safe subset: enough to render the widget, no secret. */
export async function getPublicTurnstileConfig() {
  const setting = await getTurnstileSetting();
  const enabled = Boolean(setting?.enabled && setting.siteKey && setting.encryptedSecretKey);

  return {
    enabled,
    siteKey: enabled ? (setting?.siteKey ?? null) : null,
    forms: {
      signup: enabled && (setting?.protectSignup ?? false),
      login: enabled && (setting?.protectLogin ?? false),
      passwordReset: enabled && (setting?.protectPasswordReset ?? false),
      contact: enabled && (setting?.protectContact ?? false),
      checkout: enabled && (setting?.protectCheckout ?? false),
      newsletter: enabled && (setting?.protectNewsletter ?? false)
    }
  };
}

function resolveSecret(setting: TurnstileSetting, masterEncryptionKey: string) {
  if (!setting.encryptedSecretKey || !setting.secretKeyNonce || !setting.secretKeyAuthTag) return undefined;

  return decryptSecret(
    {
      encryptedPayload: setting.encryptedSecretKey,
      nonce: setting.secretKeyNonce,
      authTag: setting.secretKeyAuthTag
    },
    masterEncryptionKey
  );
}

/**
 * Verifies a Turnstile response token for one form.
 *
 * Returns `ok: true` when the form is not protected — callers can therefore
 * always verify and let the admin decide which forms are gated. When the form IS
 * protected, a missing token, a rejected token, or an unreachable Cloudflare all
 * fail closed: an outage must not become an open signup endpoint.
 */
export async function verifyTurnstile(input: {
  form: TurnstileForm;
  token: string | undefined;
  remoteIp?: string;
  masterEncryptionKey: string;
  logger?: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
}): Promise<TurnstileVerification> {
  const setting = await getTurnstileSetting();
  if (!setting?.enabled) return { ok: true };

  const protectsForm = setting[formToColumn[input.form]] === true;
  if (!protectsForm) return { ok: true };

  const secret = resolveSecret(setting, input.masterEncryptionKey);
  if (!secret) {
    // Enabled but misconfigured. Refuse rather than silently accept.
    input.logger?.error(
      { form: input.form },
      "Turnstile is enabled but no secret key is stored; rejecting the request"
    );
    return { ok: false, error: "captcha_unavailable" };
  }

  if (!input.token) return { ok: false, error: "captcha_required" };

  const body = new URLSearchParams({ secret, response: input.token });
  if (input.remoteIp) body.set("remoteip", input.remoteIp);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    });

    if (!response.ok) {
      input.logger?.error({ status: response.status }, "Turnstile siteverify returned a non-2xx response");
      return { ok: false, error: "captcha_unavailable" };
    }

    const payload = (await response.json()) as { success?: boolean; "error-codes"?: string[] };
    if (payload.success === true) return { ok: true };

    input.logger?.warn(
      { form: input.form, codes: payload["error-codes"] },
      "Turnstile challenge rejected"
    );
    return { ok: false, error: "captcha_failed", codes: payload["error-codes"] };
  } catch (error) {
    input.logger?.error(error, "Turnstile siteverify request failed");
    return { ok: false, error: "captcha_unavailable" };
  }
}

/** Reads the widget token from the request body, accepting Cloudflare's field name too. */
export function readTurnstileToken(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const candidate = record.turnstileToken ?? record["cf-turnstile-response"];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** HTTP status + payload for a failed verification, so routes stay uniform. */
export function turnstileFailureResponse(verification: TurnstileVerification) {
  const messages: Record<NonNullable<TurnstileVerification["error"]>, string> = {
    captcha_required: "Please complete the bot-protection challenge.",
    captcha_failed: "The bot-protection challenge could not be verified. Please try again.",
    captcha_unavailable: "Bot protection is temporarily unavailable. Please try again shortly."
  };

  const error = verification.error ?? "captcha_failed";
  return {
    status: error === "captcha_unavailable" ? 503 : 400,
    body: { error, message: messages[error] }
  };
}

/** The real client IP, honouring the proxy headers Fastify has already parsed. */
export function clientIp(request: FastifyRequest) {
  return request.ip;
}
