"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Braces,
  Check,
  Cloud,
  FileLock2,
  KeyRound,
  MonitorUp,
  ScrollText,
  SquareTerminal
} from "lucide-react";
import { cx } from "@onshell/ui";

const plans = [
  {
    code: "starter",
    name: "Starter",
    price: { monthly: 19, yearly: 190 },
    limit: "5 users / 20 hosts",
    description: "Secure browser SSH and SFTP for small teams.",
    features: ["SSH terminal", "SFTP manager", "Credential vault", "30-day audit logs"]
  },
  {
    code: "business",
    name: "Business",
    price: { monthly: 49, yearly: 490 },
    limit: "25 users / 150 hosts",
    description: "RDP, snippets, and team controls for growing DevOps teams.",
    features: ["Everything in Starter", "Browser RDP", "Team snippets", "180-day audit logs"],
    highlighted: true
  },
  {
    code: "enterprise",
    name: "Enterprise",
    price: { monthly: 149, yearly: 1490 },
    limit: "Custom scale",
    description: "Governance, custom retention, and dedicated support.",
    features: ["Unlimited hosts", "Custom audit retention", "SAML/OIDC ready", "Dedicated success"]
  }
];

const featureCards = [
  {
    icon: SquareTerminal,
    title: "Browser SSH",
    text: "Open fully audited terminals in a tab. No local client, no exposed keys, no jump-box sprawl."
  },
  {
    icon: FileLock2,
    title: "SFTP file manager",
    text: "Browse, upload, and edit remote files with per-user permission checks on every operation."
  },
  {
    icon: MonitorUp,
    title: "RDP gateway",
    text: "Launch Windows desktops through controlled gateway sessions — recorded and policy-bound."
  },
  {
    icon: KeyRound,
    title: "Credential vault",
    text: "Store keys and passwords encrypted at rest. Members connect without ever seeing secrets."
  },
  {
    icon: Braces,
    title: "Team snippets",
    text: "Share vetted one-liners and runbooks so routine operations stay consistent across the team."
  },
  {
    icon: ScrollText,
    title: "Audit logs",
    text: "Every session, file transfer, and admin change is logged with retention that matches your plan."
  }
];

const steps = [
  {
    number: "01",
    title: "Connect your hosts",
    text: "Register servers over SSH, SFTP, or RDP and store their credentials in the encrypted vault."
  },
  {
    number: "02",
    title: "Invite your team",
    text: "Assign roles and per-host access. Members sign in with email, Google, or 2FA-protected accounts."
  },
  {
    number: "03",
    title: "Work from anywhere",
    text: "Open terminals, move files, and launch desktops from any browser — every action audited."
  }
];

const terminalScript = [
  {
    cmd: "ssh deploy@edge-01",
    out: ["Connected through Onshell gateway — session recorded."]
  },
  {
    cmd: "docker compose ps",
    out: ["NAME   STATUS      PORTS", "api    Up 4 days   4000/tcp", "web    Up 4 days   3000/tcp"]
  },
  {
    cmd: 'echo "shipped from a browser tab"',
    out: ["shipped from a browser tab"]
  }
];

const typingPauseTicks = 10;

type BillingInterval = "monthly" | "yearly";

interface ApiPlan {
  code: string;
  name: string;
  description: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  maxUsers?: number | null;
  maxHosts?: number | null;
  features: string[];
}

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export default function PublicPage() {
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [apiPlans, setApiPlans] = useState<ApiPlan[]>([]);
  const [checkoutEmail, setCheckoutEmail] = useState("");
  const [checkoutOrganization, setCheckoutOrganization] = useState("");
  const [checkoutStatus, setCheckoutStatus] = useState("");
  const [terminal, setTerminal] = useState({ line: 0, chars: 0 });

  useEffect(() => {
    let active = true;
    fetch(`${apiBaseUrl}/plans`)
      .then((response) => (response.ok ? response.json() : []))
      .then((payload: ApiPlan[]) => {
        if (active && Array.isArray(payload)) setApiPlans(payload);
      })
      .catch(() => {
        if (active) setApiPlans([]);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTerminal({ line: terminalScript.length, chars: 0 });
      return;
    }

    const timer = window.setInterval(() => {
      setTerminal((current) => {
        if (current.line >= terminalScript.length) {
          window.clearInterval(timer);
          return current;
        }
        const command = terminalScript[current.line].cmd;
        if (current.chars < command.length + typingPauseTicks) {
          return { line: current.line, chars: current.chars + 1 };
        }
        return { line: current.line + 1, chars: 0 };
      });
    }, 55);

    return () => window.clearInterval(timer);
  }, []);

  const visiblePlans =
    apiPlans.length > 0
      ? apiPlans.map((plan) => ({
          code: plan.code,
          name: plan.name,
          price: {
            monthly: Math.round(plan.priceMonthlyCents / 100),
            yearly: Math.round(plan.priceYearlyCents / 100)
          },
          limit: `${plan.maxUsers ?? "Custom"} users / ${plan.maxHosts ?? "Custom"} hosts`,
          description: plan.description,
          features: plan.features,
          highlighted: plan.code === "business"
        }))
      : plans;

  async function startCheckout(planCode: string) {
    if (!checkoutEmail || !checkoutOrganization) {
      setCheckoutStatus("Enter customer email and organization name before buying a package.");
      return;
    }

    setCheckoutStatus("Preparing checkout...");
    try {
      const response = await fetch(`${apiBaseUrl}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planCode,
          billingInterval: interval,
          email: checkoutEmail,
          organizationName: checkoutOrganization
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        setCheckoutStatus(payload.error ?? "Checkout failed.");
        return;
      }

      if (payload.checkoutUrl) {
        setCheckoutStatus(`Redirecting to ${payload.provider ?? "checkout"}...`);
        window.location.href = payload.checkoutUrl;
        return;
      }

      setCheckoutStatus(`Checkout is not ready yet: ${payload.status ?? "provider missing"}.`);
    } catch {
      setCheckoutStatus("Checkout service is not reachable.");
    }
  }

  return (
    <main className="public-page">
      <nav className="public-nav" aria-label="Public">
        <a className="brand-row brand-link" href="/">
          <div className="brand-mark">
            <Cloud size={18} />
          </div>
          <div>
            <p className="brand-name">Onshell.cloud</p>
            <p className="brand-domain">Browser remote access</p>
          </div>
        </a>
        <div className="public-nav-links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
        </div>
        <div className="public-nav-actions">
          <a href="/login">Login</a>
          <a className="primary-link" href="#pricing">
            Get started
          </a>
        </div>
      </nav>

      <section className="public-hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            SSH · SFTP · RDP — one browser workspace
          </span>
          <h1>Secure remote access, straight from the browser.</h1>
          <p>
            Onshell.cloud gives your team audited terminals, a file manager, RDP sessions, an encrypted credential
            vault, shared snippets, and admin billing controls — without installing a single client.
          </p>
          <div className="hero-actions">
            <a className="primary-button large" href="#pricing">
              Choose a package
              <ArrowRight size={18} />
            </a>
            <a className="secondary-link" href="/console">
              View live console
            </a>
          </div>
          <p className="hero-trust">No agents to install · Encrypted vault · Full session audit</p>
        </div>

        <div className="hero-terminal" aria-hidden="true">
          <div className="hero-terminal-bar">
            <span />
            <span />
            <span />
            <p>deploy@edge-01 — onshell</p>
          </div>
          <div className="hero-terminal-body">
            {terminalScript.map((entry, index) => {
              if (index > terminal.line) return null;
              const isTyping = index === terminal.line;
              const commandText = isTyping ? entry.cmd.slice(0, terminal.chars) : entry.cmd;
              return (
                <div key={entry.cmd}>
                  <p className="term-line">
                    <span className="term-prompt">deploy@edge-01:~$</span> {commandText}
                    {isTyping && <span className="term-caret" />}
                  </p>
                  {!isTyping &&
                    entry.out.map((line) => (
                      <p className="term-output" key={line}>
                        {line}
                      </p>
                    ))}
                </div>
              );
            })}
            {terminal.line >= terminalScript.length && (
              <p className="term-line">
                <span className="term-prompt">deploy@edge-01:~$</span> <span className="term-caret" />
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="feature-section" id="features">
        <div className="section-heading">
          <div>
            <span className="section-eyebrow">Everything in one workspace</span>
            <h2>The remote-access toolkit your team already needs</h2>
            <p>Six capabilities that usually take six tools — behind one login, one policy, one audit trail.</p>
          </div>
        </div>
        <div className="feature-grid">
          {featureCards.map((feature) => (
            <FeatureCard key={feature.title} {...feature} />
          ))}
        </div>
      </section>

      <section className="steps-section" id="how-it-works">
        <div className="section-heading">
          <div>
            <span className="section-eyebrow">How it works</span>
            <h2>From bare servers to audited access in an afternoon</h2>
          </div>
        </div>
        <div className="steps-grid">
          {steps.map((step) => (
            <div className="step-card" key={step.number}>
              <span className="step-number">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="pricing-section" id="pricing">
        <div className="section-heading">
          <div>
            <span className="section-eyebrow">Pricing</span>
            <h2>Packages customers can buy and start using</h2>
            <p>Plans map directly to limits the admin panel can manage.</p>
          </div>
          <div className="pricing-toggle-group">
            <div className="segmented pricing-toggle">
              <button
                className={cx(interval === "monthly" && "selected")}
                type="button"
                onClick={() => setInterval("monthly")}
              >
                Monthly
              </button>
              <button
                className={cx(interval === "yearly" && "selected")}
                type="button"
                onClick={() => setInterval("yearly")}
              >
                Yearly
              </button>
            </div>
            <span className="pricing-hint">Yearly billing includes 2 months free</span>
          </div>
        </div>

        <div className="checkout-strip">
          <label htmlFor="checkout-email">
            Customer email
            <input
              id="checkout-email"
              onChange={(event) => setCheckoutEmail(event.target.value)}
              placeholder="buyer@company.com"
              type="email"
              value={checkoutEmail}
            />
          </label>
          <label htmlFor="checkout-organization">
            Organization
            <input
              id="checkout-organization"
              onChange={(event) => setCheckoutOrganization(event.target.value)}
              placeholder="Company name"
              value={checkoutOrganization}
            />
          </label>
          <p aria-live="polite">{checkoutStatus || "Buyer details are passed to the configured billing provider."}</p>
        </div>

        <div className="pricing-grid">
          {visiblePlans.map((plan) => (
            <article className={cx("pricing-card", plan.highlighted && "highlighted")} key={plan.code}>
              {plan.highlighted && <span className="plan-badge">Most popular</span>}
              <div>
                <h3>{plan.name}</h3>
                <p>{plan.description}</p>
              </div>
              <div className="price-row">
                <strong>${plan.price[interval]}</strong>
                <span>/{interval === "monthly" ? "mo" : "yr"}</span>
              </div>
              <span className="limit-pill">{plan.limit}</span>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={16} />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <button
                className={cx("plan-button", plan.highlighted && "primary")}
                type="button"
                onClick={() => startCheckout(plan.code)}
              >
                Buy {plan.name}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="cta-band">
        <h2>Ready to open a shell?</h2>
        <p>Pick a package, invite your team, and connect to your first host today.</p>
        <div className="hero-actions centered">
          <a className="primary-button large" href="#pricing">
            Choose a package
            <ArrowRight size={18} />
          </a>
          <a className="secondary-link" href="/login">
            Sign in instead
          </a>
        </div>
      </section>

      <footer className="public-footer">
        <div className="footer-grid">
          <div className="footer-brand">
            <div className="brand-row">
              <div className="brand-mark">
                <Cloud size={18} />
              </div>
              <div>
                <p className="brand-name">Onshell.cloud</p>
                <p className="brand-domain">Browser remote access</p>
              </div>
            </div>
            <p>Audited SSH, SFTP, and RDP for teams that live in the terminal but work in the browser.</p>
          </div>
          <div className="footer-column">
            <strong>Product</strong>
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className="footer-column">
            <strong>Account</strong>
            <a href="/login">Login</a>
            <a href="/console">Console</a>
            <a href="/admin">Admin</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© 2026 Onshell.cloud. All rights reserved.</p>
        </div>
      </footer>
    </main>
  );
}

function FeatureCard({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="feature-card">
      <div className="feature-icon">
        <Icon size={20} />
      </div>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
