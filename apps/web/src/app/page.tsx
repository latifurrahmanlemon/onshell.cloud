"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Check,
  Cloud,
  FileLock2,
  MonitorUp,
  ShieldCheck,
  SquareTerminal,
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
        <div className="brand-row">
          <div className="brand-mark">
            <Cloud size={18} />
          </div>
          <div>
            <p className="brand-name">Onshell.cloud</p>
            <p className="brand-domain">Browser remote access SaaS</p>
          </div>
        </div>
        <div className="public-nav-actions">
          <a href="/login">Login</a>
          <a href="/console">Console</a>
          <a href="/admin">Admin</a>
          <a className="primary-link" href="#pricing">
            Pricing
          </a>
        </div>
      </nav>

      <section className="public-hero">
        <div className="hero-preview" aria-hidden="true">
          <div className="preview-sidebar" />
          <div className="preview-main">
            <div className="preview-row wide" />
            <div className="preview-metrics">
              <span />
              <span />
              <span />
            </div>
            <div className="preview-table">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
        <div className="hero-copy">
          <span className="eyebrow">SSH + SFTP + RDP in one browser workspace</span>
          <h1>Sell secure remote access as a SaaS package.</h1>
          <p>
            Onshell.cloud gives teams a browser terminal, file manager, RDP sessions, credential vault, snippets, audit logs,
            and admin billing controls from one platform.
          </p>
          <div className="hero-actions">
            <a className="primary-button large" href="#pricing">
              Choose Package
              <ArrowRight size={18} />
            </a>
            <a className="secondary-link" href="/console">
              View Console
            </a>
          </div>
        </div>
      </section>

      <section className="public-band">
        <div className="feature-strip">
          <Feature icon={SquareTerminal} title="Browser SSH" text="Open audited terminals without exposing raw credentials." />
          <Feature icon={FileLock2} title="SFTP Vault" text="Upload, edit, and manage files with permission checks." />
          <Feature icon={MonitorUp} title="RDP Gateway" text="Launch browser RDP through controlled gateway sessions." />
          <Feature icon={ShieldCheck} title="Admin Control" text="Manage plans, SMTP, billing, users, and security policy." />
        </div>
      </section>

      <section className="pricing-section" id="pricing">
        <div className="section-heading">
          <div>
            <h2>Packages customers can buy and start using</h2>
            <p>Plans map directly to limits the admin panel can manage.</p>
          </div>
          <div className="segmented pricing-toggle">
            <button className={cx(interval === "monthly" && "selected")} type="button" onClick={() => setInterval("monthly")}>
              MONTHLY
            </button>
            <button className={cx(interval === "yearly" && "selected")} type="button" onClick={() => setInterval("yearly")}>
              YEARLY
            </button>
          </div>
        </div>

        <div className="checkout-strip">
          <label>
            Customer Email
            <input
              onChange={(event) => setCheckoutEmail(event.target.value)}
              placeholder="buyer@company.com"
              type="email"
              value={checkoutEmail}
            />
          </label>
          <label>
            Organization
            <input
              onChange={(event) => setCheckoutOrganization(event.target.value)}
              placeholder="Company name"
              value={checkoutOrganization}
            />
          </label>
          <p>{checkoutStatus || "Buyer details are passed to the configured billing provider."}</p>
        </div>

        <div className="pricing-grid">
          {visiblePlans.map((plan) => (
            <article className={cx("pricing-card", plan.highlighted && "highlighted")} key={plan.code}>
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
              <button className={cx("plan-button", plan.highlighted && "primary")} type="button" onClick={() => startCheckout(plan.code)}>
                Buy {plan.name}
              </button>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function Feature({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="feature-item">
      <Icon size={20} />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}
