"use client";

import { FormEvent, useState, type ReactNode } from "react";
import { ArrowRight, Send } from "lucide-react";
import { OnshellMark } from "../app/brand";
import { ThemeToggle } from "../app/theme";
import { apiBaseUrl, site } from "../lib/site";
import { PublicSessionBadge } from "./public-session";
import { TurnstileWidget, useTurnstile } from "./turnstile";

const navLinks = [
  { href: "/#features", label: "Features" },
  { href: "/desktop", label: "Desktop app" },
  { href: "/browser-ssh-client", label: "Browser SSH" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/donate", label: "Donate" },
  { href: "/security", label: "Security" },
  // Last, and marked external, because it leaves the site — but present in the
  // primary nav rather than buried in the footer: "you can read the code" is a
  // reason people choose this product, not a legal footnote.
  { href: site.repoUrl, label: "Source", external: true }
];

/** Marketing email capture. Guarded by Turnstile when an admin enables it. */
function NewsletterForm() {
  const turnstile = useTurnstile("newsletter");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("busy");
    setMessage("");

    try {
      const response = await fetch(`${apiBaseUrl}/newsletter`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          source: "footer",
          ...(turnstile.token ? { turnstileToken: turnstile.token } : {})
        })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        turnstile.reset();
        setState("error");
        setMessage(payload.message ?? "That didn't work. Please try again.");
        return;
      }

      setState("done");
      setMessage(payload.message ?? "You're on the list.");
      setEmail("");
    } catch {
      turnstile.reset();
      setState("error");
      setMessage("Network error. Please try again.");
    }
  }

  if (state === "done") {
    return (
      <p className="lp-newsletter-done" role="status">
        {message}
      </p>
    );
  }

  return (
    <form className="lp-newsletter" onSubmit={submit} noValidate>
      <label className="sr-only" htmlFor="newsletter-email">
        Email address
      </label>
      <div className="lp-newsletter-row">
        <input
          id="newsletter-email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <button type="submit" disabled={state === "busy" || !email || !turnstile.ready}>
          <Send aria-hidden="true" size={15} />
          <span>{state === "busy" ? "Joining…" : "Subscribe"}</span>
        </button>
      </div>
      <TurnstileWidget key={turnstile.widgetKey} {...turnstile.widgetProps} />
      {message && (
        <p className={`lp-newsletter-msg ${state === "error" ? "is-error" : ""}`} role="status">
          {message}
        </p>
      )}
      <p className="lp-newsletter-note">Product updates and SSH tips. No spam, unsubscribe anytime.</p>
    </form>
  );
}

export function PublicNav() {
  return (
    <nav className="lp-nav" aria-label="Primary">
      <div className="lp-container lp-nav-inner">
        <a className="lp-brand" href="/" aria-label={`${site.name} — home`}>
          <OnshellMark size={36} />
          <span className="lp-brand-text">
            <span className="brand-name">{site.name}</span>
            <span className="brand-domain">SSH for teams</span>
          </span>
        </a>
        <div className="lp-nav-links">
          {navLinks.map((link) => (
            <a
              href={link.href}
              key={link.href}
              {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {link.label}
            </a>
          ))}
        </div>
        <div className="lp-nav-actions">
          <ThemeToggle />
          <PublicSessionBadge />
        </div>
      </div>
    </nav>
  );
}

export function PublicFooter() {
  return (
    <footer className="lp-footer">
      <div className="lp-container lp-footer-grid">
        <div className="lp-footer-brand">
          <a className="lp-brand" href="/">
            <OnshellMark size={36} />
            <span className="lp-brand-text">
              <span className="brand-name">{site.name}</span>
              <span className="brand-domain">SSH for teams</span>
            </span>
          </a>
          <p>
            Audited SSH, SFTP, and RDP for teams, with an encrypted credential vault — from a browser tab, or
            from the open-source desktop app.
          </p>
          <NewsletterForm />
        </div>
        <div className="lp-footer-col">
          <strong>Product</strong>
          <a href="/#features">Features</a>
          <a href="/desktop">Desktop app</a>
          <a href="/browser-ssh-client">Browser SSH client</a>
          <a href="/download">Downloads</a>
          <a href="/#how-it-works">How it works</a>
          <a href="/#pricing">Pricing</a>
          <a href="/#faq">FAQ</a>
        </div>
        <div className="lp-footer-col">
          <strong>Open source</strong>
          <a href="/donate">Support Onshell</a>
          <a href={site.repoUrl} rel="noreferrer" target="_blank">
            Source on GitHub
          </a>
          <a href={`${site.repoUrl}/blob/master/docs/architecture.md`} rel="noreferrer" target="_blank">
            Architecture
          </a>
          <a href={`${site.repoUrl}/blob/master/SECURITY.md`} rel="noreferrer" target="_blank">
            Security policy
          </a>
          <a href={`${site.repoUrl}/blob/master/CONTRIBUTING.md`} rel="noreferrer" target="_blank">
            Contributing
          </a>
          <a href={site.licenseUrl} rel="noreferrer" target="_blank">
            {site.licenseName} licence
          </a>
        </div>
        <div className="lp-footer-col">
          <strong>Company</strong>
          <a href="/security">Security</a>
          <a href="/contact">Contact us</a>
          <a href={`mailto:${site.salesEmail}`}>Talk to sales</a>
          <a href={`mailto:${site.supportEmail}`}>Support</a>
        </div>
        <div className="lp-footer-col">
          <strong>Account</strong>
          <a href="/login">Log in</a>
          <a href="/signup">Start free</a>
          <a href="/console">Console</a>
        </div>
      </div>
      <div className="lp-container lp-footer-bottom">
        <p>
          © {site.foundedYear} {site.name}. All rights reserved.
        </p>
        <p className="lp-footer-meta">
          SSH · SFTP · RDP — from a browser or the desktop app ·{" "}
          <a href={site.repoUrl} rel="noreferrer" target="_blank">
            open source under {site.licenseName}
          </a>
        </p>
      </div>
    </footer>
  );
}

/**
 * Page chrome for the non-app routes. Keeping nav and footer in one component
 * means the session badge, newsletter capture, and internal link graph stay
 * consistent across every indexable page.
 */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <main className="lp-page">
      <PublicNav />
      {children}
      <PublicFooter />
    </main>
  );
}

/** Shared hero for the secondary marketing pages. */
export function PageHero({
  eyebrow,
  title,
  lead,
  primaryCta,
  secondaryCta
}: {
  eyebrow: string;
  title: ReactNode;
  lead: string;
  primaryCta?: { href: string; label: string };
  secondaryCta?: { href: string; label: string };
}) {
  return (
    <section className="lp-subhero">
      <span className="lp-hero-glow" aria-hidden="true" />
      <div className="lp-container lp-subhero-inner">
        <span className="lp-eyebrow">
          <span className="lp-eyebrow-dot" aria-hidden="true" />
          {eyebrow}
        </span>
        <h1>{title}</h1>
        <p className="lp-hero-lead">{lead}</p>
        {(primaryCta || secondaryCta) && (
          <div className="lp-hero-actions">
            {primaryCta && (
              <a className="primary-button large" href={primaryCta.href}>
                {primaryCta.label}
                <ArrowRight aria-hidden="true" size={18} />
              </a>
            )}
            {secondaryCta && (
              <a className="secondary-button lp-hero-secondary" href={secondaryCta.href}>
                {secondaryCta.label}
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
