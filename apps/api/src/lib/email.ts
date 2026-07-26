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

function createTransport(smtp: SmtpSetting, masterEncryptionKey: string) {
  if (!smtp.enabled) {
    throw new Error("SMTP is disabled");
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
