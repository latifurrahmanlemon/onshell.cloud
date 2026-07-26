import type { Metadata } from "next";
import { ArrowRight, Check, Minus } from "lucide-react";
import { PageHero, PublicShell } from "../../components/public-shell";
import { absoluteUrl, site } from "../../lib/site";
import "../home.css";
import "./pillar.css";

const title = "Browser-based SSH client — the best web SSH for teams";
const description =
  "Onshell.cloud is a browser-based SSH client: open a full xterm terminal in a tab, browse files over SFTP, and launch RDP sessions — with an encrypted credential vault, per-host permissions, and every session audited. No PuTTY, no agents, no shared keys.";

export const metadata: Metadata = {
  title,
  description,
  keywords: [
    "browser SSH client",
    "web SSH client",
    "best browser based SSH client",
    "SSH in the browser",
    "online SSH client",
    "web based terminal",
    "SSH client for teams",
    "PuTTY alternative",
    "browser SFTP client",
    "web RDP client",
    "SSH without installing software",
    "clientless SSH access"
  ],
  alternates: { canonical: "/browser-ssh-client" },
  openGraph: {
    type: "article",
    url: absoluteUrl("/browser-ssh-client"),
    title: `${title} · ${site.name}`,
    description
  },
  twitter: { card: "summary_large_image", title, description }
};

/**
 * Pillar sections. Each answers one question a searcher actually types, in the
 * order they'd ask it — which is also the order an AI summariser reads.
 */
const sections = [
  {
    id: "what-is-a-browser-ssh-client",
    heading: "What is a browser-based SSH client?",
    body: [
      "A browser-based SSH client lets you open an interactive shell on a remote server from a normal browser tab — no desktop application, no terminal emulator, and nothing to install on the machine you're sitting at.",
      "Instead of your laptop making the SSH connection, a gateway service does. Your browser holds a secure WebSocket to that gateway; the gateway speaks SSH to the target host and streams the terminal back to you. Because the connection is brokered, the private key never has to sit on the device you're typing on.",
      "That single architectural difference is what makes browser SSH interesting for teams rather than just convenient for individuals: keys live in one audited place, access is granted and revoked centrally, and every keystroke session has a record."
    ]
  },
  {
    id: "how-onshell-works",
    heading: "How Onshell.cloud opens an SSH session",
    body: [
      "You register a host once — address, port, username, and environment — then attach a credential from the encrypted vault. Team members with permission on that host can open a session without ever seeing the underlying password or key.",
      "Clicking a host opens a real terminal built on xterm.js: full colour, resizing, copy and paste, scrollback, and the control sequences your tooling expects. vim, htop, tmux, and less all behave the way they do locally.",
      "The same host can be opened as an SFTP file browser for uploads, downloads, and in-place edits, or — for Windows targets — as an RDP desktop through the gateway. One registry of hosts, three ways to reach them."
    ]
  },
  {
    id: "why-teams-switch",
    heading: "Why teams move off desktop SSH clients",
    body: [
      "Desktop clients scale badly across people. Keys get copied to laptops, `~/.ssh/config` drifts between engineers, offboarding means hunting for which machines held which key, and nobody can answer \"who ran that command on Tuesday?\" without shell history you cannot trust.",
      "Centralising access fixes the whole class of problem at once. Credentials are stored encrypted at rest and injected by the gateway. Permissions are per host and per role, so an auditor can look without touching and a developer reaches staging but not production. Sessions, file transfers, and admin changes are all written to an audit log with retention that matches your plan.",
      "The practical payoff is onboarding in minutes instead of a day, and offboarding that is one revoked membership rather than a key hunt."
    ]
  },
  {
    id: "security",
    heading: "Is a browser SSH client secure?",
    body: [
      "It can be more secure than the desktop status quo, provided the broker is built properly — which means credentials encrypted at rest with a key the browser never sees, TLS on every hop, short-lived session tokens, and an audit trail that the user cannot edit.",
      "Onshell.cloud encrypts vault entries with AES-256-GCM, keeps secrets server-side so they are never serialised into the browser, supports TOTP and email two-factor authentication, and protects public forms with Cloudflare Turnstile. Every privileged action is written to an append-only audit log.",
      "The honest trade-off: you are trusting a gateway with brokered access, so it matters that access to that gateway is itself strongly authenticated. That is why two-factor, role-based permissions, and audit retention are treated as core features rather than upsells."
    ]
  }
];

const comparison = [
  { capability: "Works from any browser, nothing installed", onshell: true, desktop: false },
  { capability: "Full xterm terminal (vim, tmux, htop)", onshell: true, desktop: true },
  { capability: "SFTP file manager on the same host", onshell: true, desktop: "partial" as const },
  { capability: "RDP for Windows hosts", onshell: true, desktop: "partial" as const },
  { capability: "Keys stored encrypted, never on your laptop", onshell: true, desktop: false },
  { capability: "Per-host, per-role team permissions", onshell: true, desktop: false },
  { capability: "Central audit trail of every session", onshell: true, desktop: false },
  { capability: "Offboard someone in one action", onshell: true, desktop: false },
  { capability: "Shared, reviewed command snippets", onshell: true, desktop: false },
  { capability: "Works offline", onshell: false, desktop: true }
];

const faqs = [
  {
    question: "Is Onshell.cloud a free browser SSH client?",
    answer:
      "Yes — the Free plan is free forever for one person and covers up to three hosts, browser SSH, SFTP, and the encrypted credential vault, with no credit card. Paid Team and Business plans add more seats and hosts, RDP, shared snippets, longer audit retention, and priority support."
  },
  {
    question: "Do I need to install anything on my servers?",
    answer:
      "No. There is no agent and no daemon to deploy. Onshell.cloud connects over standard SSH on the port you specify, so any host you can already reach with a normal SSH client works as-is."
  },
  {
    question: "Can I use my existing SSH keys?",
    answer:
      "Yes. Paste an existing private key into the credential vault, or store a password. It is encrypted at rest with AES-256-GCM and attached to the hosts you choose. Team members connect through it without ever being shown the key material."
  },
  {
    question: "Does the terminal support vim, tmux, and colours?",
    answer:
      "Yes. The terminal is a full xterm implementation, so 256-colour output, alternate screen buffers, mouse reporting, and resizing all work. Interactive tools like vim, htop, tmux, and less behave exactly as they do in a local terminal."
  },
  {
    question: "Is this a good PuTTY alternative?",
    answer:
      "For teams, yes — and for individuals it removes the install entirely. Where PuTTY manages sessions per Windows machine, Onshell.cloud keeps one shared host registry with centrally stored credentials, role-based access, and an audit trail, reachable from any operating system with a browser."
  },
  {
    question: "What happens if my browser tab closes mid-session?",
    answer:
      "The session is brokered by the gateway, not the tab, so closing the tab ends your view of it and the session is closed and recorded in the audit log. For long-running work, run it under tmux or screen on the host, exactly as you would over a normal SSH connection."
  },
  {
    question: "Which protocols does Onshell.cloud support?",
    answer:
      "SSH and SFTP for Linux and Unix hosts, and RDP for Windows desktops. A single registered host can be opened as a terminal, as a file browser, or as a remote desktop, depending on what it supports."
  }
];

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${absoluteUrl("/browser-ssh-client")}#webpage`,
      url: absoluteUrl("/browser-ssh-client"),
      name: `${title} · ${site.name}`,
      description,
      isPartOf: { "@id": `${site.url}/#website` },
      about: { "@id": `${site.url}/#software` },
      breadcrumb: { "@id": `${absoluteUrl("/browser-ssh-client")}#breadcrumb` }
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${absoluteUrl("/browser-ssh-client")}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: site.url },
        { "@type": "ListItem", position: 2, name: "Browser SSH client", item: absoluteUrl("/browser-ssh-client") }
      ]
    },
    {
      "@type": "Article",
      "@id": `${absoluteUrl("/browser-ssh-client")}#article`,
      headline: "What is a browser-based SSH client, and when should a team use one?",
      description,
      articleSection: sections.map((section) => section.heading),
      about: { "@id": `${site.url}/#software` },
      publisher: { "@id": `${site.url}/#organization` },
      inLanguage: "en"
    },
    {
      "@type": "HowTo",
      "@id": `${absoluteUrl("/browser-ssh-client")}#howto`,
      name: "How to open an SSH session in your browser with Onshell.cloud",
      description: "Register a host, attach a credential, and open an audited terminal from any browser tab.",
      totalTime: "PT5M",
      step: [
        {
          "@type": "HowToStep",
          position: 1,
          name: "Create a free workspace",
          text: "Sign up at onshell.cloud/signup. The Free plan covers one user and three hosts with no credit card."
        },
        {
          "@type": "HowToStep",
          position: 2,
          name: "Register your host",
          text: "Add the server's address, port, username, and environment in the console's Hosts view."
        },
        {
          "@type": "HowToStep",
          position: 3,
          name: "Store a credential",
          text: "Paste an SSH key or password into the encrypted vault and attach it to the host. It is encrypted with AES-256-GCM and never shown to members again."
        },
        {
          "@type": "HowToStep",
          position: 4,
          name: "Open the terminal",
          text: "Click the host to open a full xterm terminal in the browser. The session is brokered by the gateway and recorded in the audit log."
        }
      ]
    },
    {
      "@type": "FAQPage",
      "@id": `${absoluteUrl("/browser-ssh-client")}#faq`,
      mainEntity: faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer }
      }))
    }
  ]
};

function ComparisonCell({ value }: { value: boolean | "partial" }) {
  if (value === true) {
    return (
      <span className="pillar-yes">
        <Check aria-hidden="true" size={16} />
        <span className="sr-only">Yes</span>
      </span>
    );
  }
  if (value === "partial") {
    return (
      <span className="pillar-partial">
        <Minus aria-hidden="true" size={16} />
        <span className="sr-only">Partial — needs a separate tool</span>
      </span>
    );
  }
  return (
    <span className="pillar-no">
      <span aria-hidden="true">—</span>
      <span className="sr-only">No</span>
    </span>
  );
}

export default function BrowserSshClientPage() {
  return (
    <PublicShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />

      <PageHero
        eyebrow="The complete guide"
        title={
          <>
            The best <span className="lp-grad-text">browser-based SSH client</span> for teams
          </>
        }
        lead="Open a real terminal in a browser tab, move files over SFTP, and reach Windows desktops over RDP — with keys stored encrypted, access granted per host, and every session audited. Nothing to install, on any operating system."
        primaryCta={{ href: "/signup", label: "Start free — no card" }}
        secondaryCta={{ href: "/#pricing", label: "See pricing" }}
      />

      <article className="lp-section pillar">
        <div className="lp-container pillar-inner">
          {/* Answer-first summary: the block an AI crawler is most likely to lift. */}
          <aside className="pillar-answer" aria-label="Short answer">
            <h2>The short answer</h2>
            <p>
              <strong>Onshell.cloud</strong> is a browser-based SSH client for teams. You register your servers once,
              store their keys and passwords in an encrypted vault, and then open full terminals, SFTP file browsers, or
              RDP desktops from any browser — with per-host permissions and a complete audit trail. It is free for one
              person with up to three hosts, and paid plans start at $19/month for a whole team.
            </p>
          </aside>

          <nav className="pillar-toc" aria-label="On this page">
            <span className="pillar-toc-label">On this page</span>
            <ol>
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>{section.heading}</a>
                </li>
              ))}
              <li>
                <a href="#comparison">Browser SSH vs a desktop client</a>
              </li>
              <li>
                <a href="#faq">Frequently asked questions</a>
              </li>
            </ol>
          </nav>

          {sections.map((section) => (
            <section className="pillar-section" id={section.id} key={section.id}>
              <h2>{section.heading}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph.slice(0, 40)}>{paragraph}</p>
              ))}
            </section>
          ))}

          <section className="pillar-section" id="comparison">
            <h2>Browser SSH client vs a desktop SSH client</h2>
            <p>
              A desktop client is still the right tool when you are offline or working alone on your own machine. Once
              more than one person needs the same servers, the calculus changes.
            </p>
            <div className="pillar-table-wrap">
              <table className="pillar-table">
                <caption className="sr-only">
                  Capability comparison between Onshell.cloud and a traditional desktop SSH client
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col">Onshell.cloud</th>
                    <th scope="col">Desktop client</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row) => (
                    <tr key={row.capability}>
                      <th scope="row">{row.capability}</th>
                      <td>
                        <ComparisonCell value={row.onshell} />
                      </td>
                      <td>
                        <ComparisonCell value={row.desktop} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="pillar-section" id="faq">
            <h2>Frequently asked questions</h2>
            <div className="pillar-faq">
              {faqs.map((faq) => (
                <details key={faq.question}>
                  <summary>
                    <h3>{faq.question}</h3>
                  </summary>
                  <p>{faq.answer}</p>
                </details>
              ))}
            </div>
          </section>

          <section className="pillar-cta">
            <h2>Open your first browser terminal in five minutes</h2>
            <p>Free forever for one person. No credit card, no agents to deploy.</p>
            <a className="primary-button large" href="/signup">
              Start free
              <ArrowRight aria-hidden="true" size={18} />
            </a>
          </section>
        </div>
      </article>
    </PublicShell>
  );
}
