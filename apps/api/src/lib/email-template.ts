/**
 * The one place transactional email is composed.
 *
 * Every send site used to inline its own `<p>` tag, which meant six different
 * ideas of what an Onshell email looks like, an invitation that pasted an
 * inviter's name and an organization name straight into HTML, and a plain-text
 * part hand-written beside the HTML one with nothing keeping the two in step.
 * Routes now describe *content* — a heading, some paragraphs, a code, a button —
 * and this module owns the markup, the escaping, and the matching text body.
 *
 * Constraints that explain the shape of the markup below, because they are not
 * obvious and they are not negotiable:
 *
 * - Tables, not divs, and every rule written as a `style=` attribute. Gmail
 *   strips `<head>` CSS on some clients and Outlook renders through Word, so any
 *   design that only exists in a stylesheet is a design most recipients never
 *   see. The `<style>` block here is progressive enhancement only — remove it and
 *   the email still looks finished.
 * - No remote images at all, including the logo. Images are blocked by default in
 *   most clients, so the mark is a coloured table cell with a prompt glyph in it.
 *   It renders identically with images off, which is the common case.
 * - Explicit `color` on every text node. Clients that force dark mode invert what
 *   they find; a node that inherited its colour ends up dark-on-dark.
 */

/** Canonical brand palette, taken from the web app's light theme tokens. */
const COLOR = {
  page: "#f4f3fb",
  card: "#ffffff",
  border: "#e4e1f2",
  heading: "#191733",
  body: "#3b3860",
  muted: "#565377",
  soft: "#6c6a8c",
  accent: "#4f46e5",
  accentDark: "#4338ca",
  tint: "#f3f0fe",
  tintBorder: "#ddd6fb",
  quote: "#faf9ff"
} as const;

/**
 * Family names are single-quoted, not double-quoted.
 *
 * These stacks are interpolated into `style="…"` attributes, and CSS treats the
 * two quote styles identically — but HTML does not. `"Segoe UI"` closes the
 * attribute at the S and leaves the rest of the declaration as stray markup, so
 * every element it touches loses its entire style block.
 */
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const PRODUCT_NAME = "Onshell.cloud";
const PRODUCT_TAGLINE = "Browser and desktop SSH, SFTP, and RDP access for teams.";
const AUTOMATED_NOTE = "This is an automated transactional message from Onshell.cloud.";

/** Escapes text for interpolation into element content or a quoted attribute. */
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes a URL for an `href`, and refuses anything that is not a web or mail
 * link.
 *
 * Every URL in these emails is built from our own config, but that has been true
 * of plenty of `javascript:` holes: one day a builder takes a redirect target
 * from a request. A refused link renders as a dead `#` rather than something the
 * recipient's client might execute.
 */
function escapeUrl(value: string) {
  const trimmed = value.trim();
  return /^(https?:|mailto:|\/)/i.test(trimmed) ? escapeHtml(trimmed) : "#";
}

export interface EmailContent {
  /** Lives beside the body so subject and content cannot drift apart. */
  subject: string;
  /** The hidden snippet clients print next to the subject in the inbox list. */
  preheader: string;
  heading: string;
  paragraphs?: string[];
  /** A one-time code, shown large on a tinted panel. */
  code?: { value: string; label?: string; caption?: string };
  /** Key/value rows, for notifications that carry submitted fields. */
  details?: Array<{ label: string; value: string }>;
  /** A block that must keep the author's own line breaks, e.g. a message body. */
  quote?: { label: string; body: string };
  cta?: { label: string; url: string };
  /** Muted closing lines: expiry, "if you did not request this", and so on. */
  footnotes?: string[];
  /** Footer link target; comes from the runtime config, never from the env here. */
  siteUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const paragraphStyle = `margin:0 0 16px;font-family:${FONT_STACK};font-size:15px;line-height:1.65;color:${COLOR.body};`;

/**
 * The header lockup, drawn rather than fetched.
 *
 * A 40px cell in brand indigo with a shell prompt in it, beside the wordmark as
 * live text. Outlook squares off the corners because Word has no border-radius —
 * an acceptable loss, and the only alternative was a remote image the client
 * would have blocked anyway.
 */
function renderHeader() {
  return `
        <tr>
          <td style="padding:0 6px 20px;">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0">
              <tr>
                <td width="40" height="40" align="center" valign="middle" bgcolor="${COLOR.accent}" style="width:40px;height:40px;border-radius:12px;background-color:${COLOR.accent};font-family:${MONO_STACK};font-size:16px;font-weight:700;color:#ffffff;text-align:center;">&gt;_</td>
                <td valign="middle" class="os-heading" style="padding-left:12px;font-family:${FONT_STACK};font-size:17px;font-weight:700;letter-spacing:-0.2px;color:${COLOR.heading};">Onshell<span style="color:${COLOR.accent};">.cloud</span></td>
              </tr>
            </table>
          </td>
        </tr>`;
}

function renderParagraphs(paragraphs: string[]) {
  return paragraphs.map((text) => `<p class="os-body" style="${paragraphStyle}">${escapeHtml(text)}</p>`).join("");
}

/**
 * The code panel. Letter-spacing on a monospace face is what makes a six-digit
 * code readable enough to retype from a phone, and the trailing spacer span stops
 * the last digit sitting flush against its own tracking.
 */
function renderCode(code: NonNullable<EmailContent["code"]>) {
  const caption = code.caption
    ? `<div class="os-muted" style="margin-top:12px;font-family:${FONT_STACK};font-size:13px;line-height:1.5;color:${COLOR.muted};">${escapeHtml(code.caption)}</div>`
    : "";

  return `
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;margin:0 0 24px;border-collapse:separate;">
                <tr>
                  <td align="center" class="os-panel" bgcolor="${COLOR.tint}" style="padding:24px 20px;background-color:${COLOR.tint};border:1px solid ${COLOR.tintBorder};border-radius:14px;">
                    <div class="os-muted" style="font-family:${FONT_STACK};font-size:11px;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:${COLOR.muted};">${escapeHtml(code.label ?? "Your code")}</div>
                    <div class="os-code" style="margin-top:10px;font-family:${MONO_STACK};font-size:34px;font-weight:700;letter-spacing:9px;line-height:1.2;color:${COLOR.heading};">${escapeHtml(code.value)}<span style="letter-spacing:0;">&#8203;</span></div>
                    ${caption}
                  </td>
                </tr>
              </table>`;
}

function renderDetails(details: NonNullable<EmailContent["details"]>) {
  const rows = details
    .map(
      (row) => `
                  <tr>
                    <td valign="top" class="os-muted" style="padding:9px 14px 9px 0;font-family:${FONT_STACK};font-size:13px;font-weight:600;color:${COLOR.muted};white-space:nowrap;border-bottom:1px solid ${COLOR.border};">${escapeHtml(row.label)}</td>
                    <td valign="top" class="os-heading" style="padding:9px 0;font-family:${FONT_STACK};font-size:14px;line-height:1.5;color:${COLOR.heading};border-bottom:1px solid ${COLOR.border};">${escapeHtml(row.value)}</td>
                  </tr>`
    )
    .join("");

  return `
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;margin:0 0 24px;border-collapse:collapse;">
                ${rows}
              </table>`;
}

/** Preserves the author's line breaks without a `<pre>` that would refuse to wrap. */
function renderQuote(quote: NonNullable<EmailContent["quote"]>) {
  const body = escapeHtml(quote.body).replace(/\r?\n/g, "<br />");

  return `
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;margin:0 0 24px;border-collapse:separate;">
                <tr>
                  <td class="os-panel" style="padding:18px 20px;background-color:${COLOR.quote};border:1px solid ${COLOR.border};border-left:3px solid ${COLOR.accent};border-radius:0 12px 12px 0;">
                    <div class="os-muted" style="margin-bottom:8px;font-family:${FONT_STACK};font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:${COLOR.soft};">${escapeHtml(quote.label)}</div>
                    <div class="os-body" style="font-family:${FONT_STACK};font-size:14px;line-height:1.65;color:${COLOR.body};word-break:break-word;">${body}</div>
                  </td>
                </tr>
              </table>`;
}

/**
 * Bulletproof button plus the raw URL underneath.
 *
 * `bgcolor` on the cell carries the fill for clients that drop the anchor's own
 * background, and the padding lives on the anchor so the whole coloured area is
 * clickable. The pasteable link is not a fallback for the styled anchor failing
 * to render — it is for the clients and corporate gateways that rewrite or strip
 * the href entirely.
 */
function renderCta(cta: NonNullable<EmailContent["cta"]>) {
  const href = escapeUrl(cta.url);

  return `
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:4px 0 22px;">
                <tr>
                  <td align="center" bgcolor="${COLOR.accent}" style="background-color:${COLOR.accent};border-radius:10px;">
                    <a href="${href}" style="display:inline-block;padding:14px 30px;font-family:${FONT_STACK};font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(cta.label)}</a>
                  </td>
                </tr>
              </table>
              <p class="os-muted" style="margin:0 0 4px;font-family:${FONT_STACK};font-size:13px;line-height:1.6;color:${COLOR.muted};">Button not working? Paste this link into your browser:</p>
              <p style="margin:0 0 20px;font-family:${MONO_STACK};font-size:12px;line-height:1.6;word-break:break-all;"><a href="${href}" style="color:${COLOR.accentDark};text-decoration:underline;">${escapeHtml(cta.url)}</a></p>`;
}

function renderFootnotes(footnotes: string[]) {
  const lines = footnotes
    .map(
      (text) =>
        `<p class="os-muted" style="margin:0 0 8px;font-family:${FONT_STACK};font-size:13px;line-height:1.6;color:${COLOR.soft};">${escapeHtml(text)}</p>`
    )
    .join("");

  return `
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;margin-top:8px;">
                <tr>
                  <td style="padding-top:20px;border-top:1px solid ${COLOR.border};">${lines}</td>
                </tr>
              </table>`;
}

function renderFooter(siteUrl: string) {
  const href = escapeUrl(siteUrl);
  const label = siteUrl.replace(/^https?:\/\//, "");

  return `
        <tr>
          <td style="padding:24px 6px 8px;">
            <p class="os-heading" style="margin:0 0 6px;font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${COLOR.heading};">${PRODUCT_NAME}</p>
            <p class="os-muted" style="margin:0 0 6px;font-family:${FONT_STACK};font-size:13px;line-height:1.6;color:${COLOR.muted};">${PRODUCT_TAGLINE}</p>
            <p style="margin:0 0 10px;font-family:${FONT_STACK};font-size:13px;line-height:1.6;"><a href="${href}" style="color:${COLOR.accentDark};text-decoration:none;">${escapeHtml(label)}</a></p>
            <p class="os-muted" style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:${COLOR.soft};">${AUTOMATED_NOTE}</p>
          </td>
        </tr>`;
}

/**
 * Progressive enhancement only: a stacking rule for narrow screens and a dark
 * palette for the clients that honour `prefers-color-scheme`. Everything here is
 * an override of a value already set inline, so a client that strips the block
 * loses nothing but the adaptation.
 */
const HEAD_STYLE = `
    <style>
      @media only screen and (max-width: 600px) {
        .os-card-pad { padding: 28px 22px 30px !important; }
        .os-code { font-size: 28px !important; letter-spacing: 6px !important; }
      }
      @media (prefers-color-scheme: dark) {
        .os-page { background-color: #0d0e18 !important; }
        .os-card { background-color: #161722 !important; border-color: #2a2c40 !important; }
        .os-heading, .os-code { color: #f2f2f8 !important; }
        .os-body { color: #cdcde0 !important; }
        .os-muted { color: #a6a8c0 !important; }
        .os-panel { background-color: #1d1e30 !important; border-color: #383b57 !important; }
      }
    </style>`;

/**
 * Assembles both bodies from one content object.
 *
 * The text part is derived rather than supplied by the caller: every send site
 * previously wrote it by hand next to the HTML, which is a copy waiting to drift
 * the first time an expiry window or a piece of wording changes on one side only.
 */
export function renderEmail(content: EmailContent): RenderedEmail {
  return { subject: content.subject, html: renderHtml(content), text: renderText(content) };
}

function renderHtml(content: EmailContent) {
  const blocks = [
    content.paragraphs?.length ? renderParagraphs(content.paragraphs) : "",
    content.code ? renderCode(content.code) : "",
    content.details?.length ? renderDetails(content.details) : "",
    content.quote ? renderQuote(content.quote) : "",
    content.cta ? renderCta(content.cta) : "",
    content.footnotes?.length ? renderFootnotes(content.footnotes) : ""
  ].join("");

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(content.subject)}</title>${HEAD_STYLE}
  </head>
  <body class="os-page" style="margin:0;padding:0;width:100%;background-color:${COLOR.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
    <div style="display:none;overflow:hidden;line-height:1px;max-height:0;max-width:0;opacity:0;mso-hide:all;">${escapeHtml(content.preheader)}</div>
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" class="os-page" style="width:100%;background-color:${COLOR.page};">
      <tr>
        <td align="center" style="padding:32px 14px 40px;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;">${renderHeader()}
            <tr>
              <td class="os-card" bgcolor="${COLOR.card}" style="background-color:${COLOR.card};border:1px solid ${COLOR.border};border-radius:16px;box-shadow:0 10px 30px rgba(60,45,120,0.07);">
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;">
                  <tr>
                    <td height="4" bgcolor="${COLOR.accent}" style="height:4px;font-size:0;line-height:0;background-color:${COLOR.accent};background-image:linear-gradient(90deg,#4f46e5 0%,#9333ea 52%,#db2777 100%);border-radius:15px 15px 0 0;">&#8203;</td>
                  </tr>
                  <tr>
                    <td class="os-card-pad" style="padding:34px 40px 36px;">
                      <h1 class="os-heading" style="margin:0 0 16px;font-family:${FONT_STACK};font-size:22px;font-weight:700;line-height:1.35;letter-spacing:-0.3px;color:${COLOR.heading};">${escapeHtml(content.heading)}</h1>${blocks}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>${renderFooter(content.siteUrl)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

function renderText(content: EmailContent) {
  const parts: string[] = [`${PRODUCT_NAME}`, "", content.heading.toUpperCase(), ""];

  for (const paragraph of content.paragraphs ?? []) {
    parts.push(paragraph, "");
  }

  if (content.code) {
    parts.push(`${content.code.label ?? "Your code"}: ${content.code.value}`);
    if (content.code.caption) parts.push(content.code.caption);
    parts.push("");
  }

  for (const row of content.details ?? []) {
    parts.push(`${row.label}: ${row.value}`);
  }
  if (content.details?.length) parts.push("");

  if (content.quote) {
    parts.push(`${content.quote.label}:`, "", content.quote.body, "");
  }

  if (content.cta) {
    parts.push(`${content.cta.label}:`, content.cta.url, "");
  }

  for (const footnote of content.footnotes ?? []) {
    parts.push(footnote);
  }
  if (content.footnotes?.length) parts.push("");

  parts.push("--", `${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`, content.siteUrl, AUTOMATED_NOTE);

  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

const roleDescriptions: Record<string, string> = {
  admin: "an admin",
  devops: "a DevOps engineer",
  developer: "a developer",
  auditor: "an auditor",
  owner: "an owner"
};

export function organizationInvitationEmail(input: {
  inviterName: string;
  organizationName: string;
  role: string;
  acceptUrl: string;
  expiresInDays: number;
  siteUrl: string;
}): RenderedEmail {
  const role = roleDescriptions[input.role] ?? `a ${input.role}`;

  return renderEmail({
    subject: `${input.inviterName} invited you to ${input.organizationName} on ${PRODUCT_NAME}`,
    preheader: `Accept your invitation to ${input.organizationName} — the link expires in ${input.expiresInDays} days.`,
    heading: `Join ${input.organizationName} on Onshell.cloud`,
    paragraphs: [
      `${input.inviterName} has invited you to join ${input.organizationName} as ${role}.`,
      "Onshell.cloud gives your team SSH, SFTP, and RDP access to shared servers from the browser or the desktop app — no keys to pass around, and every session recorded in one audit trail."
    ],
    cta: { label: "Accept the invitation", url: input.acceptUrl },
    footnotes: [
      `This invitation expires in ${input.expiresInDays} days.`,
      "If you were not expecting it, you can ignore this email — nothing is created until you accept."
    ],
    siteUrl: input.siteUrl
  });
}

export function signInCodeEmail(input: { code: string; expiresInMinutes: number; siteUrl: string }): RenderedEmail {
  return renderEmail({
    subject: `Your ${PRODUCT_NAME} sign-in code`,
    preheader: `${input.code} is your sign-in code. It expires in ${input.expiresInMinutes} minutes.`,
    heading: "Finish signing in",
    paragraphs: ["Enter this code to complete two-factor authentication and sign in."],
    code: {
      value: input.code,
      label: "Sign-in code",
      caption: `Expires in ${input.expiresInMinutes} minutes.`
    },
    footnotes: [
      "If you did not try to sign in, someone else may have your password. Change it, and do not share this code with anyone."
    ],
    siteUrl: input.siteUrl
  });
}

export function twoFactorChangeCodeEmail(input: {
  code: string;
  purpose: "enable" | "disable";
  expiresInMinutes: number;
  siteUrl: string;
}): RenderedEmail {
  const action = input.purpose === "enable" ? "turn on" : "turn off";

  return renderEmail({
    subject: `Your ${PRODUCT_NAME} verification code`,
    preheader: `${input.code} confirms that you want to ${action} email two-factor authentication.`,
    heading: `Confirm you want to ${action} two-factor authentication`,
    paragraphs: [`Enter this code in Onshell.cloud to ${action} email two-factor authentication on your account.`],
    code: {
      value: input.code,
      label: "Verification code",
      caption: `Expires in ${input.expiresInMinutes} minutes.`
    },
    footnotes:
      input.purpose === "disable"
        ? [
            "Turning two-factor authentication off leaves your password as the only thing protecting your servers.",
            "If you did not ask for this change, do not enter the code — change your password instead."
          ]
        : ["If you did not ask for this change, you can ignore this email."],
    siteUrl: input.siteUrl
  });
}

export function passwordResetEmail(input: {
  code: string;
  expiresInMinutes: number;
  siteUrl: string;
}): RenderedEmail {
  return renderEmail({
    subject: `Your ${PRODUCT_NAME} password reset code`,
    preheader: `${input.code} is your password reset code. It expires in ${input.expiresInMinutes} minutes.`,
    heading: "Reset your password",
    paragraphs: ["Enter this code on the password reset page to choose a new password."],
    code: {
      value: input.code,
      label: "Reset code",
      caption: `Expires in ${input.expiresInMinutes} minutes.`
    },
    footnotes: [
      "If you did not request a password reset, you can ignore this email — your current password still works."
    ],
    siteUrl: input.siteUrl
  });
}

export function contactNotificationEmail(input: {
  name: string;
  email: string;
  company?: string | null;
  topic: string;
  message: string;
  adminUrl: string;
  siteUrl: string;
}): RenderedEmail {
  const details = [
    { label: "Topic", value: input.topic },
    { label: "Name", value: input.name },
    { label: "Email", value: input.email }
  ];
  if (input.company) details.push({ label: "Company", value: input.company });

  return renderEmail({
    subject: `[${PRODUCT_NAME}] ${input.topic} enquiry from ${input.name}`,
    preheader: `${input.name} <${input.email}> sent a ${input.topic} enquiry.`,
    heading: "New enquiry from the contact form",
    details,
    quote: { label: "Message", body: input.message },
    cta: { label: "Open in the admin inbox", url: input.adminUrl },
    siteUrl: input.siteUrl
  });
}

export function smtpTestEmail(input: { siteUrl: string }): RenderedEmail {
  return renderEmail({
    subject: `${PRODUCT_NAME} SMTP test`,
    preheader: "SMTP is configured correctly — this test message was delivered.",
    heading: "SMTP is working",
    paragraphs: [
      "Onshell.cloud sent this from your configured mail server, so sign-in codes, password resets, and invitations will reach your users.",
      "It also doubles as a rendering check: if the button, the code panel, and the wordmark above look right in this client, the real emails will too."
    ],
    code: { value: "123456", label: "Sample code panel", caption: "Not a real code — nothing to enter." },
    cta: { label: "Open Onshell.cloud", url: input.siteUrl },
    footnotes: ["Sent from the SMTP settings page in the platform admin area."],
    siteUrl: input.siteUrl
  });
}
