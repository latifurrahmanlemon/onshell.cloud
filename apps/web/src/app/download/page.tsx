import type { Metadata } from "next";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Cpu,
  Download,
  KeyRound,
  MonitorSmartphone,
  Play,
  ShieldCheck,
  Terminal
} from "lucide-react";
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
        lead="A browser cannot open a terminal on the machine it is running on, and it cannot speak SSH — those are the sandbox the whole web rests on. Onshell Desktop is the program that can do both: your own machine's shell in the same window as your servers, and connections that go straight from your computer to your host instead of through ours. For a machine with no desktop at all, the command-line agent shares that machine with your workspace instead."
      />

      {/* The two ways, stated before either download. The desktop app leads
          because it is the right answer for almost everyone asking — it needs
          no Node, no terminal and no unpacking — while the CLI build is the
          only answer for a headless server, which is not a minority case in
          this product. Naming both up front stops the reader from taking the
          first download they see and finding out afterwards that the other one
          was meant for them. */}
      <section className="lp-section dl-ways-section" id="ways">
        <div className="lp-container">
          <div className="lp-heading">
            <span className="lp-section-eyebrow">Two ways to install</span>
            <h2>Pick the one that fits the machine</h2>
            <p>Both pair the same way and give you the same terminal. They differ only in what the machine has to have already.</p>
          </div>

          <div className="dl-ways">
            <article className="dl-way dl-way-lead">
              <span className="dl-way-badge">
                <Check aria-hidden="true" size={13} />
                Recommended
              </span>
              <h3>
                <MonitorSmartphone aria-hidden="true" size={19} />
                Desktop app
              </h3>
              <p className="dl-way-lead-text">
                The whole console as a native app. It brings its own runtime, so there is nothing to install first
                and nothing to type — and it can do the two things a browser tab cannot.
              </p>
              <ul className="dl-way-points">
                <li>
                  <Check aria-hidden="true" size={15} />
                  Your own computer&apos;s terminal, with no network in the path
                </li>
                <li>
                  <Check aria-hidden="true" size={15} />
                  Direct SSH — the traffic never passes through our servers
                </li>
                <li>
                  <Check aria-hidden="true" size={15} />
                  Optionally shares this machine, so a browser elsewhere can reach it
                </li>
                <li>
                  <Check aria-hidden="true" size={15} />
                  Windows, macOS and Linux — Intel and ARM
                </li>
              </ul>
              <a className="primary-button large dl-way-btn" href={desktopReleaseUrl} rel="noreferrer" target="_blank">
                <Download aria-hidden="true" size={18} />
                Get Onshell Desktop
                <ArrowUpRight aria-hidden="true" size={16} />
              </a>
              <p className="dl-way-note">
                <span className="dl-way-beta">Beta</span> Unsigned for now, so your OS will ask you to confirm.
              </p>
            </article>

            <article className="dl-way">
              <h3>
                <Terminal aria-hidden="true" size={19} />
                Command-line agent
              </h3>
              <p className="dl-way-lead-text">
                One file you run from a shell. This is the build for a machine with no desktop — a VPS, a headless
                box, anything you reach over SSH — and the one to script into a provisioning step.
              </p>
              <ul className="dl-way-points">
                <li>
                  <Check aria-hidden="true" size={15} />
                  Runs where there is no desktop to install into
                </li>
                <li>
                  <Check aria-hidden="true" size={15} />
                  Needs Node.js 22 already on the machine
                </li>
                <li>
                  <Check aria-hidden="true" size={15} />
                  Published with a SHA-256 for every build
                </li>
              </ul>
              <a className="secondary-button large dl-way-btn" href="#cli">
                Get the command-line build
              </a>
              <p className="dl-way-note">Six platform builds, listed further down with checksums.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="lp-section dl-picker-section" id="cli">
        <div className="lp-container">
          <div className="lp-heading dl-cli-heading">
            <span className="lp-section-eyebrow">Command-line agent</span>
            <h2>The build you run from a shell</h2>
            <p>
              If you came here for the double-click installer, it is{" "}
              <a className="dl-cli-back" href="#ways">
                the other option above
              </a>
              . This one needs Node.js 22 on the machine already.
            </p>
          </div>

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

        </div>
      </section>

      <section className="lp-section dl-steps-section">
        <div className="lp-container">
          <div className="lp-heading">
            <span className="lp-section-eyebrow">Getting started</span>
            <h2>Three steps, about two minutes</h2>
            <p>
              These are the real commands for the command-line build, not a simplified version of them. The desktop
              app needs none of this: install it and paste the code into the window.
            </p>
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
              <em>&ldquo;Windows protected your PC&rdquo;</em>, and macOS will say it{" "}
              <em>&ldquo;could not verify this app is free of malware&rdquo;</em>. Both warnings are correct to show: an
              unsigned program that opens a shell on your machine is, to a scanner, indistinguishable from malware.
            </p>
            <p>
              On macOS 15 Sequoia the only button that dialog offers is <strong>Move to Trash</strong>, and there is no
              longer a right-click&nbsp;→&nbsp;Open shortcut around it. If it has already gone to the Trash, put it back
              first — then use either of these:
            </p>
            <div className="dl-verify">
              <pre>
                <code>
                  {"# 1. Settings route: open the app once, dismiss the dialog, then go to\n"}
                  {"#    System Settings → Privacy & Security → scroll down → Open Anyway\n\n"}
                  {"# 2. Or strip the download flag yourself, then open it normally:\n"}
                  {'xattr -dr com.apple.quarantine "/Applications/Onshell Agent.app"\n'}
                </code>
              </pre>
            </div>
            <p>
              This stops the day a Developer ID certificate is in place: the build pipeline already signs and notarizes
              when one is supplied, so the same release turns out clean without a code change. Until then, verify what
              you downloaded — that is what the checksum below is for.
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
