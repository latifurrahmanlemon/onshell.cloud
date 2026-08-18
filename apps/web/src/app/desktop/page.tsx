import type { Metadata } from "next";
import { ArrowRight, ArrowUpRight, Check, Download, Minus } from "lucide-react";
import { PageHero, PublicShell } from "../../components/public-shell";
import { absoluteUrl, site } from "../../lib/site";
import "../home.css";
import "../browser-ssh-client/pillar.css";

const title = "Onshell Desktop — an open-source SSH client that connects directly";
const description =
  "Onshell Desktop is a free, open-source SSH client for Windows, macOS, and Linux. It opens your own machine's terminal with no network in the path, connects straight to your servers so no relay sees the traffic, transfers files between local and remote, and keeps hosts, credentials, and audit logs shared with your team.";

export const metadata: Metadata = {
  title,
  description,
  keywords: [
    "open source SSH client",
    "desktop SSH client",
    "SSH client Windows",
    "SSH client macOS",
    "SSH client Linux",
    "Termius alternative",
    "PuTTY alternative",
    "MobaXterm alternative",
    "SSH client with SFTP",
    "team SSH client",
    "direct SSH no relay",
    "self-hosted SSH manager",
    "AGPL SSH client"
  ],
  alternates: { canonical: "/desktop" },
  openGraph: {
    type: "article",
    url: absoluteUrl("/desktop"),
    title: `${title} · ${site.name}`,
    description
  },
  twitter: { card: "summary_large_image", title, description }
};

const downloadUrl = "https://github.com/latifurrahmanlemon/onshell-downloads/releases/latest";

/**
 * Pillar sections, in the order someone evaluating a desktop SSH client actually
 * asks: what is it, what can it do that a tab cannot, who sees my traffic, can I
 * check that claim, and how does it work for a team.
 */
const sections = [
  {
    id: "what-it-is",
    heading: "What Onshell Desktop is",
    body: [
      "Onshell Desktop is a native SSH, SFTP, and terminal client for Windows, macOS, and Linux. It manages saved hosts, an encrypted credential vault, snippets, and per-person access the same way the browser console does — because it talks to the same server — while doing two things a browser tab structurally cannot.",
      "The first is opening a terminal on the machine you are sitting at. A browser has no API for spawning a process, and never will: that is the sandbox boundary the whole web rests on. The desktop app runs a real pseudo-terminal, so your own PowerShell, zsh, bash, or WSL distribution sits in a tab next to your servers.",
      "The second is speaking SSH itself. A browser can only open HTTP and WebSocket connections, so every browser-based SSH product relays through a server that speaks SSH on your behalf. A native app just opens port 22."
    ]
  },
  {
    id: "who-sees-your-traffic",
    heading: "Who is on the wire",
    body: [
      "In direct mode, nobody. The app opens the TCP connection from your computer to your server, and Onshell's gateway has no socket in that path — it cannot see the session because it is not part of it.",
      "What the server still does is decide whether the connection is allowed and record that it happened. Access control and the audit log stay central, which is what makes this a team tool rather than a folder of SSH config files, while the bytes stay between you and your host.",
      "That also means private hosts work. A machine reachable from your laptop but not from the public internet is unreachable to any browser-based client and completely ordinary to this one.",
      "When direct is not possible — a host only your gateway can route to, an RDP session, or a machine reached through the Onshell agent — the app offers to relay instead. It offers; it does not switch quietly. A session that stopped being end-to-end without telling you would make the whole promise worthless, so the terminal shows which path it is on."
    ]
  },
  {
    id: "credentials",
    heading: "How credentials reach your machine",
    body: [
      "Connecting directly means the credential has to be on your computer, and that is worth being precise about rather than glossing over.",
      "Saved credentials live encrypted with AES-256-GCM in the vault. When you open a direct session the server checks your role, your access to that specific host, your workspace's policy, and whether this machine is an enrolled and unrevoked device — in that order, before anything is decrypted. Only then does it issue a lease: material for one host, one session, valid for about a minute.",
      "The lease is held in the app's main process, wiped from memory once the SSH handshake completes, and never written to disk or handed to the interface layer. Every issue is written to the audit log with the machine that asked, and you can revoke a machine from Settings so it gets nothing further.",
      "It does not grant access you did not already have: a lease is only ever issued for a host you could open a relayed session on anyway. It changes where the plaintext lives and who is on the wire — which is exactly what people asking for a native client are asking for."
    ]
  },
  {
    id: "open-source",
    heading: "You can read all of it",
    body: [
      "Every claim above is checkable. Onshell is published under the GNU AGPL-3.0 — the whole platform, not a client library with the interesting parts held back. The credential vault, the session broker, the gateway, the agent, and this app are all in one public repository.",
      "The build workflow that produces the installers is published too. An installer is something you run as yourself, and the only honest answer to \"what is in this binary\" is a recipe anyone can read.",
      "The AGPL is what keeps that true over time: anyone running a modified Onshell as a service owes their users that version's source, so a hosted fork cannot quietly diverge from what is published.",
      "If you would rather not trust anyone else's server at all, self-host. The server address is a setting in the app, so the same installer points at your own deployment."
    ]
  },
  {
    id: "share-this-computer",
    heading: "Sharing this computer, in the other direction",
    body: [
      "The app can also work the other way round: making the machine it runs on reachable from a browser somewhere else. Useful for a workstation you want to reach from a laptop, or a machine with no SSH server at all.",
      "It dials out to the gateway rather than listening, so there is no inbound port and NAT is not a problem. It is off until you switch it on, and while it is on the tray icon stays visible.",
      "Consent settings live on that machine, not on the server — a rule your workspace admin could change remotely would not be consent. You choose whether others can connect without asking, every session is written to a local log only you can read, and quitting the app ends all of them."
    ]
  }
];

const comparison = [
  { capability: "Terminal on your own computer", onshell: true, browser: false },
  { capability: "Traffic goes straight to your host, no relay", onshell: true, browser: false },
  { capability: "Reaches hosts on a private network or VPN", onshell: true, browser: false },
  { capability: "Works with the network unplugged (local shell)", onshell: true, browser: false },
  { capability: "Drag files between local and remote", onshell: true, browser: "partial" as const },
  { capability: "Shared host registry and credential vault", onshell: true, browser: true },
  { capability: "Per-host, per-role team permissions", onshell: true, browser: true },
  { capability: "Central audit trail", onshell: true, browser: true },
  { capability: "RDP for Windows hosts", onshell: "partial" as const, browser: true },
  { capability: "Nothing to install", onshell: false, browser: true }
];

const faqs = [
  {
    question: "Is Onshell Desktop free?",
    answer:
      "The app is free and open source under the AGPL-3.0, for any platform. It connects to an Onshell workspace, and the Free plan covers one person with up to three hosts at no cost. You can also point it at a deployment you host yourself, in which case there is nothing to pay at all."
  },
  {
    question: "Which platforms does it run on?",
    answer:
      "Windows, macOS, and Linux, on both Intel and ARM. Installers are .exe for Windows, .dmg for macOS, and AppImage or .deb for Linux."
  },
  {
    question: "Does my SSH traffic go through your servers?",
    answer:
      "Not in direct mode — the app opens the connection to your host itself, and our gateway has no socket in that path. It goes through the gateway only when you choose to relay: a host we can route to but your machine cannot, an RDP session, or a machine reached through the Onshell agent. The terminal always shows which path it is using."
  },
  {
    question: "Where are my SSH keys stored?",
    answer:
      "Encrypted with AES-256-GCM in the vault on the server, so they are shared with your team without anyone being shown the key. For a direct connection the app receives a short-lived lease for one host and one session, holds it in memory only, and wipes it once the connection is established. It is never written to disk on your machine."
  },
  {
    question: "Can I use it without an internet connection?",
    answer:
      "Your own computer's terminal works with the network completely unplugged — nothing about it touches a server. Saved hosts and credentials come from your workspace, so reaching those needs a connection to it."
  },
  {
    question: "How is this different from Termius or PuTTY?",
    answer:
      "The team layer and the fact that you can read the code. Hosts, credentials, per-person access, and audit are shared and centrally governed rather than living per laptop, and the whole platform is AGPL-3.0 so you can check what happens to your keys or run the entire thing yourself."
  },
  {
    question: "Can I self-host the server it connects to?",
    answer:
      "Yes. The server address is asked on first launch and changeable afterwards, so the same signed installer works against your own deployment. The repository has the Compose file, the migrations, and a deployment runbook. There is no licence key and no phone-home."
  },
  {
    question: "Do I still need the browser console?",
    answer:
      "No, but they work together on the same workspace. The browser is what you use from a machine that is not yours; the desktop app is what you use from your own. Admin, billing, and RDP live in the browser console."
  }
];

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${absoluteUrl("/desktop")}#webpage`,
      url: absoluteUrl("/desktop"),
      name: `${title} · ${site.name}`,
      description,
      isPartOf: { "@id": `${site.url}/#website` },
      breadcrumb: { "@id": `${absoluteUrl("/desktop")}#breadcrumb` }
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${absoluteUrl("/desktop")}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: site.url },
        { "@type": "ListItem", position: 2, name: "Desktop app", item: absoluteUrl("/desktop") }
      ]
    },
    {
      // A distinct SoftwareApplication from the hosted service: different
      // operating systems, a different price, and its own download URL, so
      // collapsing them into one entity would misdescribe both.
      "@type": "SoftwareApplication",
      "@id": `${absoluteUrl("/desktop")}#app`,
      name: "Onshell Desktop",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Windows, macOS, Linux",
      description,
      url: absoluteUrl("/desktop"),
      downloadUrl,
      license: site.licenseUrl,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${site.url}/#organization` },
      featureList: [
        "Terminal on your own computer with no network in the path",
        "Direct SSH from your machine to your host",
        "SFTP file transfer between local and remote",
        "Shared host registry and encrypted credential vault",
        "Per-host team permissions and central audit log",
        "Share this computer with your workspace",
        "Open source under AGPL-3.0",
        "Works against a self-hosted server"
      ]
    },
    {
      "@type": "HowTo",
      "@id": `${absoluteUrl("/desktop")}#howto`,
      name: "How to connect to a server with Onshell Desktop",
      description: "Install the app, point it at your Onshell server, and open a direct SSH session.",
      totalTime: "PT5M",
      step: [
        {
          "@type": "HowToStep",
          position: 1,
          name: "Install the app",
          text: "Download the installer for Windows, macOS, or Linux and run it. Nothing else needs to be installed first."
        },
        {
          "@type": "HowToStep",
          position: 2,
          name: "Choose your server",
          text: "On first launch the app asks which Onshell server to use — the hosted service, or the address of your own deployment."
        },
        {
          "@type": "HowToStep",
          position: 3,
          name: "Sign in",
          text: "Sign in with your workspace account, including two-factor if you have it enabled. Your hosts, credentials, and snippets appear."
        },
        {
          "@type": "HowToStep",
          position: 4,
          name: "Open a session",
          text: "Click a host to open a terminal that connects straight from your machine, or pick a shell under This computer to open a local one."
        }
      ]
    },
    {
      "@type": "FAQPage",
      "@id": `${absoluteUrl("/desktop")}#faq`,
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
        <span className="sr-only">Partial</span>
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

export default function DesktopPage() {
  return (
    <PublicShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />

      <PageHero
        eyebrow="Onshell Desktop"
        title={
          <>
            An SSH client that connects <span className="lp-grad-text">straight to your servers</span>
          </>
        }
        lead="Your own machine's terminal and your whole fleet in one window — with connections that go from your computer to your host, and nobody in between. Free, open source, and it works against a server you host yourself."
        primaryCta={{ href: downloadUrl, label: "Download for free" }}
        secondaryCta={{ href: "#open-source", label: "Read the source" }}
      />

      <article className="lp-section pillar">
        <div className="lp-container pillar-inner">
          {/* Answer-first summary: the block an AI crawler is most likely to lift. */}
          <aside className="pillar-answer" aria-label="Short answer">
            <h2>The short answer</h2>
            <p>
              <strong>Onshell Desktop</strong> is a free, open-source SSH and SFTP client for Windows, macOS, and
              Linux. It opens a terminal on your own computer with no network involved, connects directly to your
              servers so no relay sees the traffic, and keeps hosts, credentials, permissions, and audit logs shared
              with your team. The entire platform is published under the {site.licenseName}, so you can check exactly
              what it does with your keys — or run the server yourself.
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
                <a href="#comparison">Desktop app vs the browser console</a>
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
              {section.id === "open-source" && (
                <p>
                  <a href={site.repoUrl} rel="noreferrer" target="_blank">
                    Browse the repository on GitHub
                    <ArrowUpRight aria-hidden="true" size={15} />
                  </a>
                </p>
              )}
            </section>
          ))}

          <section className="pillar-section" id="comparison">
            <h2>Desktop app vs the browser console</h2>
            <p>
              They are the same workspace reached two ways, and most people use both. The browser is what you open on a
              machine that is not yours; the desktop app is what you keep on the one that is.
            </p>
            <div className="pillar-table-wrap">
              <table className="pillar-table">
                <caption className="sr-only">
                  Capability comparison between Onshell Desktop and the Onshell browser console
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col">Desktop app</th>
                    <th scope="col">Browser console</th>
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
                        <ComparisonCell value={row.browser} />
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
            <h2>Download Onshell Desktop</h2>
            <p>
              Windows, macOS, and Linux. Free and open source — and it works against your own server just as well as
              ours.
            </p>
            <a className="primary-button large" href={downloadUrl} rel="noreferrer" target="_blank">
              <Download aria-hidden="true" size={18} />
              Get the app
              <ArrowRight aria-hidden="true" size={18} />
            </a>
          </section>
        </div>
      </article>
    </PublicShell>
  );
}
