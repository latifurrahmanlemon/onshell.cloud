import type { Metadata } from "next";
import { Bot, Eye, FileLock2, KeyRound, Lock, Network, ScrollText, ShieldCheck, UserCheck } from "lucide-react";
import { PageHero, PublicShell } from "../../components/public-shell";
import { absoluteUrl, site } from "../../lib/site";
import "../home.css";
import "../browser-ssh-client/pillar.css";
import "./security.css";

const title = "Security";
const description =
  "How Onshell.cloud protects your servers: AES-256-GCM credential encryption, brokered sessions so keys never reach the browser, two-factor authentication, role-based per-host permissions, bot protection, and an append-only audit trail.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/security" },
  openGraph: {
    type: "website",
    url: absoluteUrl("/security"),
    title: `${title} · ${site.name}`,
    description
  },
  twitter: { card: "summary_large_image", title: `${title} · ${site.name}`, description }
};

const controls = [
  {
    icon: KeyRound,
    title: "Credentials encrypted at rest",
    text: "SSH keys, passwords, and TOTP secrets are sealed with AES-256-GCM using a master key held only in the server environment. The ciphertext is useless without it, and a database dump alone reveals nothing."
  },
  {
    icon: Network,
    title: "Sessions are brokered, not proxied to you",
    text: "The gateway holds the SSH connection and streams only terminal output to your tab. Private key material is never serialised into the browser, so a compromised laptop cannot exfiltrate it."
  },
  {
    icon: UserCheck,
    title: "Two-factor authentication",
    text: "TOTP via any authenticator app, or emailed one-time codes. Failed sign-ins are throttled per account with an escalating lock, so a distributed password-spray gets slower, not luckier."
  },
  {
    icon: Lock,
    title: "Hardened sessions",
    text: "HttpOnly, Secure, SameSite cookies scoped to the domain; HMAC-signed access tokens compared in constant time; refresh tokens are single-use and revoked in bulk on any password change."
  },
  {
    icon: Eye,
    title: "Least-privilege access",
    text: "Five roles from Owner to Auditor, with per-host permissions. An auditor can read the trail without opening a session; a developer can reach staging without touching production."
  },
  {
    icon: ScrollText,
    title: "Append-only audit trail",
    text: "Every sign-in, session, file transfer, permission change, and admin action is recorded with actor, IP, and timestamp. Retention follows your plan — from 7 days on Free to a full year on Business."
  },
  {
    icon: Bot,
    title: "Bot protection on public forms",
    text: "Cloudflare Turnstile guards signup, sign-in, password reset, and contact. Verification fails closed: if the check cannot complete, the request is refused rather than waved through."
  },
  {
    icon: FileLock2,
    title: "Transport security",
    text: "TLS on every hop, HSTS with preload, a strict Content-Security-Policy, and no framing. The API returns generic errors so internal paths and query structure never leak to a client."
  }
];

const practices = [
  {
    heading: "Secrets never ship in the repository",
    body: "The API refuses to boot in production if the JWT signing key or the master encryption key is still a placeholder from .env.example. Seeding without an explicit admin password fails in production rather than creating a known account."
  },
  {
    heading: "Defence in depth on authentication",
    body: "Rate limits are applied per endpoint on top of a global per-IP budget, and separately per account for failed sign-ins. One-time codes are hashed before storage and compared in constant time. Pending challenges expire and are capped in number so an abandoned-login flood cannot exhaust memory."
  },
  {
    heading: "Tenant isolation by construction",
    body: "Every query is scoped by organization, and record lookups are filtered by owner rather than checked after fetching. A guessed identifier returns \"not found\" instead of confirming that the record exists."
  },
  {
    heading: "Privileged reads are themselves audited",
    body: "When a platform admin opens a user's AI assistant conversation or changes a setting, that action is written to the audit log. Administration is observable, not invisible."
  }
];

const disclosure = [
  "Email security@onshell.cloud with enough detail to reproduce the issue — affected endpoint, request, and expected versus actual behaviour.",
  "We acknowledge within two business days and keep you updated until the issue is resolved.",
  "Please do not run automated scanners against production, access accounts that are not yours, or degrade service for other customers while testing.",
  "We will credit you in the release notes if you would like, and we will not pursue legal action for good-faith research that follows these guidelines."
];

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${absoluteUrl("/security")}#webpage`,
      url: absoluteUrl("/security"),
      name: `${title} · ${site.name}`,
      description,
      isPartOf: { "@id": `${site.url}/#website` },
      breadcrumb: { "@id": `${absoluteUrl("/security")}#breadcrumb` }
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${absoluteUrl("/security")}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: site.url },
        { "@type": "ListItem", position: 2, name: "Security", item: absoluteUrl("/security") }
      ]
    }
  ]
};

export default function SecurityPage() {
  return (
    <PublicShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />

      <PageHero
        eyebrow="Security"
        title={
          <>
            Brokered access, <span className="lp-grad-text">encrypted secrets</span>, complete audit
          </>
        }
        lead="Onshell.cloud sits between your team and your servers, so the controls that matter are the ones on that boundary. Here is exactly what protects it."
        primaryCta={{ href: "/contact", label: "Request a security review" }}
        secondaryCta={{ href: "/browser-ssh-client", label: "How it works" }}
      />

      <section className="lp-section" aria-labelledby="controls-heading">
        <div className="lp-container">
          <div className="lp-heading">
            <span className="lp-section-eyebrow">Controls</span>
            <h2 id="controls-heading">What protects your access</h2>
            <p>Eight controls that cover credentials, sessions, identity, and the record of what happened.</p>
          </div>
          <div className="lp-feature-grid">
            {controls.map(({ icon: Icon, title: controlTitle, text }) => (
              <article className="lp-feature-card" key={controlTitle}>
                <span className="lp-feature-icon">
                  <Icon aria-hidden="true" size={20} />
                </span>
                <h3>{controlTitle}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section pillar" aria-labelledby="practices-heading">
        <div className="lp-container pillar-inner">
          <div className="lp-heading sec-heading-left">
            <span className="lp-section-eyebrow">Engineering practice</span>
            <h2 id="practices-heading">How we build it</h2>
          </div>
          {practices.map((practice) => (
            <section className="pillar-section" key={practice.heading}>
              <h2>{practice.heading}</h2>
              <p>{practice.body}</p>
            </section>
          ))}

          <section className="pillar-section" id="disclosure">
            <h2>Responsible disclosure</h2>
            <p>
              If you have found a vulnerability, we want to hear about it before anyone else does. Reports go to{" "}
              <a href={`mailto:${site.securityEmail}`}>{site.securityEmail}</a>.
            </p>
            <ol className="sec-disclosure">
              {disclosure.map((step) => (
                <li key={step.slice(0, 30)}>{step}</li>
              ))}
            </ol>
          </section>

          <section className="pillar-section" id="shared-responsibility">
            <h2>What stays your responsibility</h2>
            <p>
              We secure the broker; you still own the hosts behind it. Keep your servers patched, prefer key
              authentication over passwords, rotate credentials in the vault on a schedule, and review the audit log and
              member list when people join or leave. Enable two-factor for every account with production access — the
              admin panel can require it.
            </p>
          </section>

          <section className="pillar-cta">
            <h2>Need a questionnaire completed?</h2>
            <p>Send us your vendor security review and we&apos;ll turn it around with real answers, not boilerplate.</p>
            <a className="primary-button large" href="/contact">
              <ShieldCheck aria-hidden="true" size={18} />
              Contact the security team
            </a>
          </section>
        </div>
      </section>
    </PublicShell>
  );
}
