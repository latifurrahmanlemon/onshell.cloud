import type { Metadata } from "next";
import { AlertTriangle, Cpu, KeyRound, MonitorSmartphone, Play, ShieldCheck, Terminal } from "lucide-react";
import { PageHero, PublicShell } from "../../components/public-shell";
import { type AgentBuild, formatBytes } from "../../lib/agent-manifest";
import { readAgentManifest } from "../../lib/agent-downloads";
import { absoluteUrl, site } from "../../lib/site";
import { DownloadPicker } from "./download-picker";
import "../home.css";
import "./download.css";

const title = "Download the Onshell Agent";
const description =
  "Install the Onshell Agent on your Windows, macOS, or Linux machine and open its terminal and files from any browser. Free, no inbound port, and the machine's owner decides who may connect.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/download" },
  openGraph: {
    type: "website",
    url: absoluteUrl("/download"),
    title: `${title} · ${site.name}`,
    description
  },
  twitter: { card: "summary_large_image", title: `${title} · ${site.name}`, description }
};

// The manifest changes when a release commit lands, not when the app is built,
// so the page is rendered per request rather than frozen at build time.
export const dynamic = "force-dynamic";

// The desktop app (a double-click installer that bundles its own runtime) ships
// as GitHub Release assets rather than files in this repo: six ~100 MB installers
// per version would bloat git permanently. `/releases/latest` always resolves to
// the newest one, so the link never needs updating per release.
//
// It points at the separate onshell-downloads repository because that one is
// public. Release assets inherit their repository's visibility, so while the
// source repo is private its release links answer 404 to everyone who is not a
// collaborator — visitors would land on a "page not found", not a download.
const desktopReleaseUrl = "https://github.com/latifurrahmanlemon/onshell-downloads/releases/latest";

const steps = [
  {
    icon: MonitorSmartphone,
    title: "Download and extract",
    body: "Pick the build for your computer above and unpack it anywhere you like — your home folder is fine. Nothing is installed system-wide and nothing runs as administrator."
  },
  {
    icon: KeyRound,
    title: "Pair it with your account",
    body: "In the console open My computers → Connect a computer. You get an eight-character code, good for ten minutes and usable once."
  },
  {
    icon: Play,
    title: "Start it",
    body: "The machine appears in your host list while the agent runs. Stop it and the access stops with it."
  }
];

const requirements = [
  { icon: Cpu, label: "Node.js 22 or newer on the machine you are installing on" },
  { icon: Terminal, label: "Windows 10 1809+, macOS 12+, or a Linux with systemd" },
  { icon: ShieldCheck, label: "Outbound HTTPS. No inbound port, no router change, no public IP" }
];

function BuildRow({ build }: { build: AgentBuild }) {
  return (
    <tr>
      <td>
        <span className="dl-table-os">{build.osLabel}</span>
        <span className="dl-table-arch">{build.archLabel}</span>
      </td>
      <td className="dl-table-mono">{build.target}</td>
      <td className="dl-table-mono">{formatBytes(build.bytes)}</td>
      <td className="dl-table-sha" title={build.sha256}>
        <code>{build.sha256.slice(0, 16)}…</code>
      </td>
      <td className="dl-table-action">
        <a className="secondary-button" href={build.path} download>
          .{build.format}
        </a>
      </td>
    </tr>
  );
}

export default async function DownloadPage() {
  const manifest = await readAgentManifest();

  const structuredData = manifest
    ? {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "Onshell Agent",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Windows, macOS, Linux",
        softwareVersion: manifest.version,
        downloadUrl: absoluteUrl("/download"),
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@type": "Organization", name: site.name, url: site.url }
      }
    : null;

  return (
    <PublicShell>
      {structuredData && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      )}

      <PageHero
        eyebrow="Onshell Agent"
        title={
          <>
            Reach <span className="lp-grad-text">your own computer</span> from any browser
          </>
        }
        lead="A browser cannot open a terminal on your machine by itself — that is the sandbox the whole web rests on. The agent is the small program that can. Install it once, pair it with your account, and your desktop is one tab away from your phone."
      />

      <section className="lp-section dl-picker-section">
        <div className="lp-container">
          {manifest ? (
            <>
              <DownloadPicker builds={manifest.builds} version={manifest.version} />
              <p className="dl-released">
                Version {manifest.version} · released{" "}
                {new Date(manifest.releasedAt).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric"
                })}
              </p>
            </>
          ) : (
            <div className="dl-hero-card dl-hero-card-idle">
              <p className="dl-hero-idle">
                No build has been published yet. Email{" "}
                <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a> and we will send you one.
              </p>
            </div>
          )}

          <div className="dl-desktop-cta">
            <div className="dl-desktop-cta-text">
              <p className="dl-desktop-cta-lead">
                Prefer a one-click installer? <span className="dl-desktop-cta-beta">Beta</span>
              </p>
              <p className="dl-desktop-cta-body">
                The desktop app bundles its own runtime — no Node, no terminal. Install it, paste your pairing
                code, and it lives in your menu bar. Unsigned for now, so your OS will ask you to confirm.
              </p>
            </div>
            <a className="secondary-button dl-desktop-cta-btn" href={desktopReleaseUrl} target="_blank" rel="noreferrer">
              Get the desktop app
            </a>
          </div>
        </div>
      </section>

      <section className="lp-section dl-steps-section">
        <div className="lp-container">
          <div className="lp-heading">
            <span className="lp-section-eyebrow">Getting started</span>
            <h2>Three steps, about two minutes</h2>
            <p>The agent has no installer yet, so these are the real commands — not a simplified version of them.</p>
          </div>

          <ol className="dl-steps">
            {steps.map((step, index) => (
              <li className="dl-step" key={step.title}>
                <span className="dl-step-num" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="dl-step-body">
                  <h3>
                    <step.icon aria-hidden="true" size={17} />
                    {step.title}
                  </h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="dl-commands">
            <p className="dl-commands-label">In the extracted folder:</p>
            <pre>
              <code>
                {"node onshell-agent.cjs pair K7QP-2M4X   # the code from the console\n"}
                {"node onshell-agent.cjs run              # start it\n"}
                {"\n"}
                {"node onshell-agent.cjs log              # everything it has done, on your disk\n"}
                {"node onshell-agent.cjs approval ask     # who may connect without asking\n"}
                {"node onshell-agent.cjs service          # how to start it at login\n"}
              </code>
            </pre>
          </div>

          <ul className="dl-requirements">
            {requirements.map((requirement) => (
              <li key={requirement.label}>
                <requirement.icon aria-hidden="true" size={16} />
                {requirement.label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="lp-section dl-warning-section">
        <div className="lp-container">
          <div className="dl-warning">
            <h2>
              <AlertTriangle aria-hidden="true" size={19} />
              Your computer will warn you about this download
            </h2>
            <p>
              These builds are not code-signed yet. Windows SmartScreen will show{" "}
              <em>&ldquo;Windows protected your PC&rdquo;</em>, and macOS Gatekeeper will refuse to open an unidentified
              developer&rsquo;s program. Both warnings are correct to show: an unsigned program that opens a shell on
              your machine is, to a scanner, indistinguishable from malware.
            </p>
            <p>
              We would rather say that here than have you discover it mid-install. Certificates are being sorted out. In
              the meantime, verify what you downloaded — that is what the checksum below is for.
            </p>
            <div className="dl-verify">
              <pre>
                <code>
                  {"# macOS / Linux\nshasum -a 256 onshell-agent-*.tar.gz\n\n# Windows PowerShell\nGet-FileHash onshell-agent-*.zip -Algorithm SHA256\n"}
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {manifest && (
        <section className="lp-section dl-all-section" id="all-downloads">
          <div className="lp-container">
            <div className="lp-heading">
              <span className="lp-section-eyebrow">All platforms</span>
              <h2>Every build in {manifest.version}</h2>
              <p>
                Compare the SHA-256 against the file you downloaded. The full list is also at{" "}
                <a href={`/downloads/agent/v${manifest.version}/SHA256SUMS.txt`}>SHA256SUMS.txt</a>.
              </p>
            </div>

            <div className="dl-table-wrap">
              <table className="dl-table">
                <thead>
                  <tr>
                    <th scope="col">Platform</th>
                    <th scope="col">Target</th>
                    <th scope="col">Size</th>
                    <th scope="col">SHA-256</th>
                    <th scope="col">
                      <span className="sr-only">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.builds.map((build) => (
                    <BuildRow build={build} key={build.target} />
                  ))}
                </tbody>
              </table>
            </div>

            {manifest.versions && manifest.versions.length > 1 && (
              <p className="dl-older">
                Earlier versions still on the server:{" "}
                {manifest.versions
                  .filter((version) => version !== manifest.version)
                  .map((version, index) => (
                    <span key={version}>
                      {index > 0 && ", "}
                      <a href={`/downloads/agent/v${version}/manifest.json`}>{version}</a>
                    </span>
                  ))}
              </p>
            )}
          </div>
        </section>
      )}
    </PublicShell>
  );
}
