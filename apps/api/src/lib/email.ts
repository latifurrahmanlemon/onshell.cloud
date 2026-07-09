import nodemailer from "nodemailer";
import type { SmtpSetting } from "@prisma/client";
import { decryptSecret } from "./encryption.js";

export async function sendSmtpTestEmail(input: {
  smtp: SmtpSetting;
  masterEncryptionKey: string;
  recipient: string;
}) {
  if (!input.smtp.enabled) {
    throw new Error("SMTP is disabled");
  }

  const password =
    input.smtp.encryptedPassword && input.smtp.passwordNonce && input.smtp.passwordAuthTag
      ? decryptSecret(
          {
            encryptedPayload: input.smtp.encryptedPassword,
            nonce: input.smtp.passwordNonce,
            authTag: input.smtp.passwordAuthTag
          },
          input.masterEncryptionKey
        )
      : undefined;

  const transporter = nodemailer.createTransport({
    host: input.smtp.host,
    port: input.smtp.port,
    secure: input.smtp.secure,
    auth: input.smtp.username
      ? {
          user: input.smtp.username,
          pass: password
        }
      : undefined
  });

  const result = await transporter.sendMail({
    from: `"${input.smtp.fromName}" <${input.smtp.fromEmail}>`,
    to: input.recipient,
    subject: "Onshell.cloud SMTP test",
    text: "SMTP is configured and Onshell.cloud can send email.",
    html: "<p>SMTP is configured and <strong>Onshell.cloud</strong> can send email.</p>"
  });

  return {
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected
  };
}

