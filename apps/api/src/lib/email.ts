import nodemailer from "nodemailer";
import type { EmailLogStatus, SmtpSetting } from "@prisma/client";
import { decryptSecret } from "./encryption.js";
import { prisma } from "./prisma.js";

type EmailLogger = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/**
 * Writes the admin-visible delivery record.
 *
 * Recipient, subject, and status only: transactional mail carries one-time codes
 * and reset links, so bodies must never reach the log. Failures here are
 * swallowed — losing a log row must not lose the email.
 */
async function recordEmailLog(input: {
  recipient: string;
  subject: string;
  kind: string;
  status: EmailLogStatus;
  providerMessageId?: string | null;
  error?: string | null;
  logger?: EmailLogger;
}) {
  try {
    await prisma.emailLog.create({
      data: {
        recipient: input.recipient.slice(0, 190),
        subject: input.subject.slice(0, 190),
        kind: input.kind,
        status: input.status,
        providerMessageId: input.providerMessageId ?? null,
        error: input.error ?? null
      }
    });
  } catch (error) {
    input.logger?.error(error, "Failed to write email log");
  }
}

/** Raised when SMTP cannot be used at all, as opposed to a send that failed. */
export class SmtpDisabledError extends Error {
  constructor() {
    super("SMTP is disabled");
    this.name = "SmtpDisabledError";
  }
}

/**
 * Turns a nodemailer failure into something an operator can act on.
 *
 * The test-email button exists to diagnose SMTP, so "internal_error" is the one
 * answer that helps nobody. Only allow-listed fields are surfaced: the library's
 * error code, the numeric SMTP reply, and the server's own response text. The
 * password lives in the transport config, never in these fields, and the caller
 * is already a platform admin looking at their own mail server's reply.
 */
export function describeSmtpFailure(error: unknown): {
  /** Whether the problem is local configuration or the far end. */
  kind: "config" | "upstream";
  message: string;
  code?: string;
  responseCode?: number;
  detail?: string;
} {
  if (error instanceof SmtpDisabledError) {
    return { kind: "config", message: "SMTP is switched off. Enable it, save, then send the test again." };
  }

  const raw = (error ?? {}) as { code?: unknown; responseCode?: unknown; response?: unknown; message?: unknown };
  const code = typeof raw.code === "string" ? raw.code : undefined;
  const responseCode = typeof raw.responseCode === "number" ? raw.responseCode : undefined;
  const response = typeof raw.response === "string" ? raw.response.trim().slice(0, 300) : undefined;
  const message = typeof raw.message === "string" ? raw.message.trim().slice(0, 300) : undefined;

  const explanations: Record<string, string> = {
    EAUTH: "The mail server rejected the username or password.",
    ECONNECTION: "Could not open a connection to the mail server. Check the host, the port, and whether TLS should be on.",
    ESOCKET: "The connection to the mail server failed — usually a TLS/port mismatch (465 needs TLS on, 587 needs it off).",
    ETIMEDOUT: "The mail server did not respond in time. Check the host and port, and that outbound SMTP is not blocked.",
    EDNS: "The mail server hostname could not be resolved.",
    EENVELOPE: "The mail server rejected the sender or recipient address.",
    EMESSAGE: "The mail server rejected the message itself."
  };

  /**
   * The system errno inside the message is more specific than nodemailer's own
   * code — a refused connection and a TLS version mismatch both arrive as
   * ESOCKET, and only one of them is about TLS.
   */
  const haystack = `${message ?? ""} ${response ?? ""}`;
  const errnoExplanations: Array<[RegExp, string]> = [
    [/ECONNREFUSED/, "Nothing is listening on that host and port — check the SMTP host and port."],
    [/ENOTFOUND|EAI_AGAIN/, "The mail server hostname could not be resolved. Check the host for a typo."],
    [/ETIMEDOUT|ECONNRESET/, "The mail server did not respond. Check the port, and that the host allows outbound SMTP."],
    [/wrong version number|SSL routines|unsupported protocol/i, "TLS mismatch: port 465 needs TLS on, 587 usually needs it off."],
    [/self.signed|certificate/i, "The mail server's TLS certificate was rejected."]
  ];
  const byErrno = errnoExplanations.find(([pattern]) => pattern.test(haystack))?.[1];

  return {
    kind: code === "EAUTH" || code === "EENVELOPE" ? "config" : "upstream",
    message: byErrno ?? (code && explanations[code]) ?? message ?? "The mail server refused the message.",
    code,
    responseCode,
    detail: response ?? (code ? message : undefined)
  };
}

function createTransport(smtp: SmtpSetting, masterEncryptionKey: string) {
  if (!smtp.enabled) {
    throw new SmtpDisabledError();
  }

  const password =
    smtp.encryptedPassword && smtp.passwordNonce && smtp.passwordAuthTag
      ? decryptSecret(
          {
            encryptedPayload: smtp.encryptedPassword,
            nonce: smtp.passwordNonce,
            authTag: smtp.passwordAuthTag
          },
          masterEncryptionKey
        )
      : undefined;

  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.username
      ? {
          user: smtp.username,
          pass: password
        }
      : undefined
  });
}

export async function sendEmail(input: {
  smtp: SmtpSetting;
  masterEncryptionKey: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
  /** Template identifier for the admin email log. */
  kind?: string;
  logger?: EmailLogger;
}) {
  const kind = input.kind ?? "transactional";

  try {
    const transporter = createTransport(input.smtp, input.masterEncryptionKey);
    const result = await transporter.sendMail({
      from: `"${input.smtp.fromName}" <${input.smtp.fromEmail}>`,
      to: input.recipient,
      subject: input.subject,
      text: input.text,
      html: input.html
    });

    await recordEmailLog({
      recipient: input.recipient,
      subject: input.subject,
      kind,
      status: "SENT",
      providerMessageId: result.messageId,
      logger: input.logger
    });

    return {
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected
    };
  } catch (error) {
    await recordEmailLog({
      recipient: input.recipient,
      subject: input.subject,
      kind,
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
      logger: input.logger
    });
    throw error;
  }
}

export async function isSmtpEnabled() {
  const smtp = await prisma.smtpSetting.findUnique({ where: { id: "global" } });
  return Boolean(smtp?.enabled);
}

export async function sendTransactionalEmail(input: {
  masterEncryptionKey: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
  /** Template identifier for the admin email log. */
  kind?: string;
  logger?: EmailLogger;
}): Promise<boolean> {
  const kind = input.kind ?? "transactional";
  const smtp = await prisma.smtpSetting.findUnique({ where: { id: "global" } });
  if (!smtp?.enabled) {
    input.logger?.info({ recipient: input.recipient, subject: input.subject }, "SMTP disabled; skipping transactional email");
    await recordEmailLog({
      recipient: input.recipient,
      subject: input.subject,
      kind,
      status: "SKIPPED",
      error: "SMTP is disabled",
      logger: input.logger
    });
    return false;
  }

  try {
    // sendEmail records the SENT/FAILED row, so nothing to log here.
    await sendEmail({
      smtp,
      masterEncryptionKey: input.masterEncryptionKey,
      recipient: input.recipient,
      subject: input.subject,
      text: input.text,
      html: input.html,
      kind,
      logger: input.logger
    });
    return true;
  } catch (error) {
    input.logger?.error(error, "Failed to send transactional email");
    return false;
  }
}

export async function sendSmtpTestEmail(input: {
  smtp: SmtpSetting;
  masterEncryptionKey: string;
  recipient: string;
}) {
  return sendEmail({
    smtp: input.smtp,
    masterEncryptionKey: input.masterEncryptionKey,
    recipient: input.recipient,
    subject: "Onshell.cloud SMTP test",
    text: "SMTP is configured and Onshell.cloud can send email.",
    html: "<p>SMTP is configured and <strong>Onshell.cloud</strong> can send email.</p>",
    kind: "smtp_test"
  });
}
