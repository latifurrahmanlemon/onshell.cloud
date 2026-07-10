import nodemailer from "nodemailer";
import type { SmtpSetting } from "@prisma/client";
import { decryptSecret } from "./encryption.js";
import { prisma } from "./prisma.js";

type EmailLogger = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

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
}) {
  const transporter = createTransport(input.smtp, input.masterEncryptionKey);
  const result = await transporter.sendMail({
    from: `"${input.smtp.fromName}" <${input.smtp.fromEmail}>`,
    to: input.recipient,
    subject: input.subject,
    text: input.text,
    html: input.html
  });

  return {
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected
  };
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
  logger?: EmailLogger;
}): Promise<boolean> {
  const smtp = await prisma.smtpSetting.findUnique({ where: { id: "global" } });
  if (!smtp?.enabled) {
    input.logger?.info({ recipient: input.recipient, subject: input.subject }, "SMTP disabled; skipping transactional email");
    return false;
  }

  try {
    await sendEmail({
      smtp,
      masterEncryptionKey: input.masterEncryptionKey,
      recipient: input.recipient,
      subject: input.subject,
      text: input.text,
      html: input.html
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
    html: "<p>SMTP is configured and <strong>Onshell.cloud</strong> can send email.</p>"
  });
}
