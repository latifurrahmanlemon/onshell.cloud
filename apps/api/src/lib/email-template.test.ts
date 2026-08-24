import { describe, expect, it } from "vitest";
import {
  contactNotificationEmail,
  organizationInvitationEmail,
  passwordResetEmail,
  renderEmail,
  signInCodeEmail,
  smtpTestEmail,
  twoFactorChangeCodeEmail,
  type RenderedEmail
} from "./email-template.js";

const SITE_URL = "https://onshell.cloud";

/**
 * The HTML and text bodies used to be written by hand side by side at each send
 * site, so a code or a link could reach one and not the other. Everything below
 * checks the two halves still say the same thing, and that the values pasted into
 * the markup are values and not markup.
 */
const codeBuilders: Array<[string, () => RenderedEmail]> = [
  ["signInCodeEmail", () => signInCodeEmail({ code: "483920", expiresInMinutes: 10, siteUrl: SITE_URL })],
  [
    "twoFactorChangeCodeEmail",
    () => twoFactorChangeCodeEmail({ code: "483920", purpose: "enable", expiresInMinutes: 10, siteUrl: SITE_URL })
  ],
  ["passwordResetEmail", () => passwordResetEmail({ code: "483920", expiresInMinutes: 15, siteUrl: SITE_URL })]
];

describe.each(codeBuilders)("%s", (_name, build) => {
  it("carries the code in both bodies", () => {
    const message = build();
    expect(message.html).toContain("483920");
    expect(message.text).toContain("483920");
  });

  it("puts the code in the preheader so it is readable from the inbox list", () => {
    expect(build().html).toMatch(/483920[^<]*<\/div>/);
  });

  it("has a subject", () => {
    expect(build().subject.length).toBeGreaterThan(0);
  });
});

describe("organizationInvitationEmail", () => {
  const message = organizationInvitationEmail({
    inviterName: "Ada Lovelace",
    organizationName: "Analytical Engines",
    role: "devops",
    acceptUrl: "https://onshell.cloud/invite?token=abc123",
    expiresInDays: 7,
    siteUrl: SITE_URL
  });

  it("puts the accept URL in the button, the pasteable fallback, and the text body", () => {
    expect(message.html).toContain('href="https://onshell.cloud/invite?token=abc123"');
    // Once in the button, once as the link the recipient can copy.
    expect(message.html.split("https://onshell.cloud/invite?token=abc123").length - 1).toBeGreaterThanOrEqual(3);
    expect(message.text).toContain("https://onshell.cloud/invite?token=abc123");
  });

  it("names the inviter, the organization, and the role", () => {
    expect(message.text).toContain("Ada Lovelace");
    expect(message.text).toContain("Analytical Engines");
    expect(message.text).toContain("a DevOps engineer");
  });

  it("states the expiry it was given rather than a hard-coded window", () => {
    const fortnight = organizationInvitationEmail({
      inviterName: "Ada",
      organizationName: "Engines",
      role: "admin",
      acceptUrl: "https://onshell.cloud/invite?token=x",
      expiresInDays: 14,
      siteUrl: SITE_URL
    });
    expect(fortnight.text).toContain("14 days");
    expect(fortnight.text).not.toContain("7 days");
  });
});

describe("escaping", () => {
  const injection = '<script>alert("xss")</script>';

  it("escapes an inviter name and an organization name", () => {
    const message = organizationInvitationEmail({
      inviterName: injection,
      organizationName: '"><img src=x onerror=alert(1)>',
      role: "admin",
      acceptUrl: "https://onshell.cloud/invite?token=abc",
      expiresInDays: 7,
      siteUrl: SITE_URL
    });

    expect(message.html).not.toContain("<script>");
    expect(message.html).not.toContain("<img src=x");
    expect(message.html).toContain("&lt;script&gt;");
  });

  it("escapes the contact form's message body while keeping its line breaks", () => {
    const message = contactNotificationEmail({
      name: injection,
      email: "visitor@example.com",
      company: "<b>Acme</b>",
      topic: "sales",
      message: `first line ${injection}\nsecond line`,
      adminUrl: "https://onshell.cloud/admin?section=inbox&message=cm1",
      siteUrl: SITE_URL
    });

    expect(message.html).not.toContain("<script>");
    expect(message.html).not.toContain("<b>Acme</b>");
    expect(message.html).toContain("&lt;script&gt;");
    // The author's own newline survives as a break, not as a swallowed line.
    expect(message.html).toContain("first line &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;<br />second line");
  });

  it("escapes the subject where it is echoed into the document title", () => {
    const message = contactNotificationEmail({
      name: injection,
      email: "visitor@example.com",
      topic: "support",
      message: "hello",
      adminUrl: "https://onshell.cloud/admin",
      siteUrl: SITE_URL
    });

    expect(message.html).toContain("<title>");
    expect(message.html).not.toMatch(/<title>[^<]*<script>/);
  });

  /**
   * Nothing builds a link from request data today, but a template that would
   * happily render `javascript:` the day one does is a hole with a fuse on it.
   */
  it("refuses a link scheme the recipient's client might execute", () => {
    const message = renderEmail({
      subject: "s",
      preheader: "p",
      heading: "h",
      cta: { label: "Go", url: "javascript:alert(1)" },
      siteUrl: SITE_URL
    });

    expect(message.html).not.toContain('href="javascript:');
    expect(message.html).toContain('href="#"');
  });
});

describe("plain text part", () => {
  const messages = [
    organizationInvitationEmail({
      inviterName: "Ada Lovelace",
      organizationName: "Analytical Engines",
      role: "developer",
      acceptUrl: "https://onshell.cloud/invite?token=abc",
      expiresInDays: 7,
      siteUrl: SITE_URL
    }),
    signInCodeEmail({ code: "112358", expiresInMinutes: 10, siteUrl: SITE_URL }),
    passwordResetEmail({ code: "112358", expiresInMinutes: 15, siteUrl: SITE_URL }),
    twoFactorChangeCodeEmail({ code: "112358", purpose: "disable", expiresInMinutes: 10, siteUrl: SITE_URL }),
    contactNotificationEmail({
      name: "Grace Hopper",
      email: "grace@example.com",
      company: "Navy",
      topic: "security",
      message: "Found something in the audit trail.\nCall me.",
      adminUrl: "https://onshell.cloud/admin?section=inbox&message=cm1",
      siteUrl: SITE_URL
    }),
    smtpTestEmail({ siteUrl: SITE_URL })
  ];

  it("contains no HTML tags", () => {
    for (const message of messages) {
      expect(message.text).not.toMatch(/<\/?[a-z][^>]*>/i);
    }
  });

  it("ends with the footer, so every message identifies itself", () => {
    for (const message of messages) {
      expect(message.text).toContain("Onshell.cloud");
      expect(message.text.trimEnd()).toMatch(/automated transactional message from Onshell\.cloud\.$/);
    }
  });

  it("never leaves a run of blank lines behind an omitted block", () => {
    for (const message of messages) {
      expect(message.text).not.toMatch(/\n{3}/);
    }
  });
});

describe("renderEmail", () => {
  it("renders a complete document with no remote asset references", () => {
    const message = smtpTestEmail({ siteUrl: SITE_URL });

    expect(message.html.startsWith("<!DOCTYPE html")).toBe(true);
    expect(message.html).toContain("</html>");
    expect(message.html).not.toMatch(/<img\b/i);
    expect(message.html).not.toMatch(/url\(/i);
  });

  /**
   * The font stacks are interpolated into `style="…"`, so a double-quoted family
   * name ends the attribute early and silently strips the styling from every
   * element it appears on — which is all of them. This caught exactly that.
   */
  it("closes every attribute it opens", () => {
    const message = contactNotificationEmail({
      name: 'Ada "Countess" Lovelace',
      email: "ada@example.com",
      topic: "general",
      message: 'He said "hello".',
      adminUrl: "https://onshell.cloud/admin?section=inbox&message=cm1",
      siteUrl: SITE_URL
    });

    for (const tag of message.html.match(/<[a-z][^>]*>/gi) ?? []) {
      expect((tag.match(/"/g) ?? []).length % 2, tag).toBe(0);
    }
    expect(message.html).toContain("'Segoe UI'");
  });

  it("omits every optional block it was not given", () => {
    const message = renderEmail({
      subject: "Bare",
      preheader: "Bare",
      heading: "Bare",
      paragraphs: ["One paragraph."],
      siteUrl: SITE_URL
    });

    expect(message.html).not.toContain("Button not working?");
    expect(message.html).not.toContain("Your code");
    expect(message.text).toContain("One paragraph.");
  });
});
