"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  Cloud,
  FileLock2,
  KeyRound,
  MonitorUp,
  ScrollText,
  SquareTerminal
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { cx } from "@onshell/ui";
import { ThemeToggle } from "./theme";
import "./home.css";

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

const stats = [
  { value: "3-in-1", label: "SSH · SFTP · RDP" },
  { value: "0", label: "Clients to install" },
  { value: "100%", label: "Sessions audited" },
  { value: "AES-256", label: "Vault encryption" }
];

const faqs = [
  {
    question: "What is Onshell.cloud?",
    answer:
      "Onshell.cloud is a browser-based remote access workspace. It gives your team audited SSH terminals, an SFTP file manager, RDP desktop sessions, an encrypted credential vault, and shared snippets — all behind one login, with no local client to install."
  },
  {
    question: "Do I need to install any software or agents?",
    answer:
      "No. Everything runs in the browser through the Onshell gateway. There are no desktop clients, browser extensions, or per-host agents to deploy — you register a host and connect from any modern browser."
  },
  {
    question: "How are my credentials and keys kept safe?",
    answer:
      "SSH keys and passwords are encrypted at rest in the credential vault. Team members connect to hosts without ever seeing the underlying secrets, and every connection is brokered through the gateway so credentials never reach the browser."
  },
  {
    question: "Which protocols and platforms are supported?",
    answer:
      "SSH and SFTP for Linux and Unix hosts, plus RDP for Windows desktops. Sessions open in a tab with a full terminal, a file browser, or a remote desktop — whichever the host needs."
  },
  {
    question: "Can I control who accesses which servers?",
    answer:
      "Yes. Assign roles and per-host permissions so each member only reaches the systems they should. Sign-in supports email, Google, and 2FA-protected accounts, and admins manage everything from the panel."
  },
  {
    question: "What gets logged for audit and compliance?",
    answer:
      "Every session, file transfer, and admin change is recorded. Audit retention matches your plan — from 30 days on Starter up to custom retention on Enterprise — so you always have a complete trail."
  },
  {
    question: "How does billing work?",
    answer:
      "Pick a package that maps to user and host limits, billed monthly or yearly (yearly includes two months free). You can upgrade, downgrade, or manage seats from the admin panel at any time."
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

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const VIEWPORT = { once: true, margin: "-80px" };

function fadeUp(reduce: boolean): Variants {
  return {
    hidden: { opacity: reduce ? 1 : 0, y: reduce ? 0 : 24 },
    show: { opacity: 1, y: 0, transition: { duration: reduce ? 0 : 0.5, ease: EASE } }
  };
}

function stagger(reduce: boolean, gap = 0.09): Variants {
  return {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : gap, delayChildren: reduce ? 0 : 0.06 } }
  };
}

function itemUp(reduce: boolean): Variants {
  return {
    hidden: { opacity: reduce ? 1 : 0, y: reduce ? 0 : 16 },
    show: { opacity: 1, y: 0, transition: { duration: reduce ? 0 : 0.45, ease: EASE } }
  };
}

/**
 * Flips to true after the first client render. Gating an entrance `animate`
 * target on this guarantees framer-motion sees a hidden→show change on mount,
 * so above-the-fold intro animations fire reliably under Next.js SSR + React 19
 * (a bare mount-time `animate` can otherwise stay stuck at its initial state).
 */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

const SITE_URL = "https://onshell.cloud";

// Rich structured data so search engines and AI crawlers can understand the
// product, its pricing, and the FAQ. Rendered as JSON-LD in the initial HTML.
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "Onshell.cloud",
      url: SITE_URL,
      logo: `${SITE_URL}/icons/icon-512.png`,
      description:
        "Browser-based SSH, SFTP, and RDP with an encrypted credential vault and full session audit for teams."
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: "Onshell.cloud",
      publisher: { "@id": `${SITE_URL}/#organization` }
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: "Onshell.cloud",
      applicationCategory: "SecurityApplication",
      operatingSystem: "Web-based (any modern browser)",
      url: SITE_URL,
      description:
        "Open audited SSH terminals, manage files over SFTP, and launch RDP sessions from one secure browser workspace — no client to install.",
      featureList: featureCards.map((card) => card.title),
      offers: plans.map((plan) => ({
        "@type": "Offer",
        name: plan.name,
        price: plan.price.monthly,
        priceCurrency: "USD",
        description: plan.description
      }))
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer }
      }))
    }
  ]
};

/**
 * The terminal types a character every 55ms. Keeping that high-frequency state
 * in its own component (below the animated wrapper) means the surrounding hero —
 * including its framer-motion entrance stagger — never re-renders on each tick.
 */
function TerminalBody() {
  const [terminal, setTerminal] = useState({ line: 0, chars: 0 });

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

  return (
    <>
      <div className="lp-terminal-bar">
        <span className="lp-dot" />
        <span className="lp-dot" />
        <span className="lp-dot" />
        <p className="lp-terminal-title">deploy@edge-01 — onshell</p>
      </div>
      <div className="lp-terminal-body">
        {terminalScript.map((entry, index) => {
          if (index > terminal.line) return null;
          const isTyping = index === terminal.line;
          const commandText = isTyping ? entry.cmd.slice(0, terminal.chars) : entry.cmd;
          return (
            <div key={entry.cmd}>
              <p className="lp-term-line">
                <span className="lp-term-prompt">deploy@edge-01:~$</span> {commandText}
                {isTyping && <span className="lp-term-caret" />}
              </p>
              {!isTyping &&
                entry.out.map((line) => (
                  <p className="lp-term-output" key={line}>
                    {line}
                  </p>
                ))}
            </div>
          );
        })}
        {terminal.line >= terminalScript.length && (
          <p className="lp-term-line">
            <span className="lp-term-prompt">deploy@edge-01:~$</span> <span className="lp-term-caret" />
          </p>
        )}
      </div>
    </>
  );
}

function HeroTerminal({ reduce }: { reduce: boolean }) {
  const mounted = useMounted();
  return (
    <motion.div
      className="lp-terminal"
      aria-hidden="true"
      initial={{ opacity: reduce ? 1 : 0, y: reduce ? 0 : 26 }}
      animate={mounted || reduce ? { opacity: 1, y: 0 } : { opacity: 0, y: 26 }}
      transition={{ duration: reduce ? 0 : 0.6, ease: EASE, delay: reduce ? 0 : 0.15 }}
    >
      <TerminalBody />
    </motion.div>
  );
}

export default function PublicPage() {
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [apiPlans, setApiPlans] = useState<ApiPlan[]>([]);
  const [checkoutEmail, setCheckoutEmail] = useState("");
  const [checkoutOrganization, setCheckoutOrganization] = useState("");
  const [checkoutStatus, setCheckoutStatus] = useState("");
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const mounted = useMounted();
  const reduce = useReducedMotion() ?? false;
  const motionVariants = useMemo(
    () => ({
      fade: fadeUp(reduce),
      stagger: stagger(reduce),
      staggerTight: stagger(reduce, 0.07),
      item: itemUp(reduce)
    }),
    [reduce]
  );

  useEffect(() => {
    let active = true;
    fetch(`${apiBaseUrl}/plans`)
      .then((response) => (response.ok ? response.json() : []))
      .then((payload: ApiPlan[]) => {
        // Only swap in live plans when there are some — otherwise keep the
        // built-in defaults and skip a needless re-render of the hero.
        if (active && Array.isArray(payload) && payload.length > 0) setApiPlans(payload);
      })
      .catch(() => {
        // Leave the built-in plans in place if the API is unreachable.
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
    <main className="lp-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <motion.nav
        className="lp-nav"
        aria-label="Primary"
        initial={{ opacity: reduce ? 1 : 0, y: reduce ? 0 : -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduce ? 0 : 0.4, ease: EASE }}
      >
        <div className="lp-container lp-nav-inner">
          <a className="lp-brand" href="/" aria-label="Onshell.cloud — home">
            <span className="brand-mark">
              <Cloud size={18} />
            </span>
            <span className="lp-brand-text">
              <span className="brand-name">Onshell.cloud</span>
              <span className="brand-domain">Browser remote access</span>
            </span>
          </a>
          <div className="lp-nav-links">
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="lp-nav-actions">
            <ThemeToggle />
            <a className="lp-login" href="/login">
              Log in
            </a>
            <a className="primary-button lp-nav-cta" href="/signup">
              Get started
            </a>
          </div>
        </div>
      </motion.nav>

      <section className="lp-hero" aria-labelledby="lp-hero-title">
        <span className="lp-hero-glow" aria-hidden="true" />
        <div className="lp-container lp-hero-inner">
          <motion.div
            className="lp-hero-copy"
            variants={motionVariants.stagger}
            initial="hidden"
            animate={mounted ? "show" : "hidden"}
          >
            <motion.span className="lp-eyebrow" variants={motionVariants.fade}>
              <span className="lp-eyebrow-dot" aria-hidden="true" />
              SSH · SFTP · RDP — one browser workspace
            </motion.span>
            <motion.h1 id="lp-hero-title" variants={motionVariants.fade}>
              Secure remote access, <span className="lp-grad-text">straight from the browser.</span>
            </motion.h1>
            <motion.p className="lp-hero-lead" variants={motionVariants.fade}>
              Onshell.cloud gives your team audited terminals, a file manager, RDP sessions, an encrypted credential
              vault, shared snippets, and admin billing controls — without installing a single client.
            </motion.p>
            <motion.div className="lp-hero-actions" variants={motionVariants.fade}>
              <a className="primary-button large" href="#pricing">
                Choose a package
                <ArrowRight size={18} />
              </a>
              <a className="secondary-button lp-hero-secondary" href="/console">
                View live console
              </a>
            </motion.div>
            <motion.p className="lp-hero-trust" variants={motionVariants.fade}>
              No agents to install · Encrypted vault · Full session audit
            </motion.p>
          </motion.div>

          <HeroTerminal reduce={reduce} />
        </div>

        <div className="lp-container">
          <motion.div
            className="lp-stats"
            variants={motionVariants.staggerTight}
            initial="hidden"
            whileInView="show"
            viewport={VIEWPORT}
          >
            {stats.map((stat) => (
              <motion.div className="lp-stat" key={stat.label} variants={motionVariants.item}>
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      <motion.section
        className="lp-section"
        id="features"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <div className="lp-container">
          <motion.div className="lp-heading" variants={motionVariants.fade}>
            <span className="lp-section-eyebrow">Everything in one workspace</span>
            <h2>The remote-access toolkit your team already needs</h2>
            <p>Six capabilities that usually take six tools — behind one login, one policy, one audit trail.</p>
          </motion.div>
          <motion.div className="lp-feature-grid" variants={motionVariants.staggerTight}>
            {featureCards.map(({ icon: Icon, title, text }) => (
              <motion.article
                className="lp-feature-card"
                key={title}
                variants={motionVariants.item}
                whileHover={reduce ? undefined : { y: -4 }}
              >
                <span className="lp-feature-icon">
                  <Icon size={20} />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </motion.article>
            ))}
          </motion.div>
        </div>
      </motion.section>

      <motion.section
        className="lp-section lp-steps"
        id="how-it-works"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <div className="lp-container">
          <motion.div className="lp-heading" variants={motionVariants.fade}>
            <span className="lp-section-eyebrow">How it works</span>
            <h2>From bare servers to audited access in an afternoon</h2>
          </motion.div>
          <motion.div className="lp-steps-grid" variants={motionVariants.staggerTight}>
            {steps.map((step) => (
              <motion.div className="lp-step-card" key={step.number} variants={motionVariants.item}>
                <span className="lp-step-number">{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </motion.section>

      <motion.section
        className="lp-section lp-pricing"
        id="pricing"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <div className="lp-container">
          <motion.div className="lp-heading lp-pricing-heading" variants={motionVariants.fade}>
            <div>
              <span className="lp-section-eyebrow">Pricing</span>
              <h2>Packages customers can buy and start using</h2>
              <p>Plans map directly to limits the admin panel can manage.</p>
            </div>
            <div className="lp-billing-wrap">
              <div className="lp-billing" role="group" aria-label="Billing interval">
                {(["monthly", "yearly"] as const).map((value) => (
                  <button
                    key={value}
                    className={cx("lp-billing-option", interval === value && "is-active")}
                    type="button"
                    aria-pressed={interval === value}
                    onClick={() => setInterval(value)}
                  >
                    {interval === value && (
                      <motion.span
                        className="lp-billing-pill"
                        layoutId="lp-billing-pill"
                        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                      />
                    )}
                    <span className="lp-billing-label">{value === "monthly" ? "Monthly" : "Yearly"}</span>
                  </button>
                ))}
              </div>
              <span className="lp-billing-hint">Yearly billing includes 2 months free</span>
            </div>
          </motion.div>

          <motion.div className="lp-checkout" variants={motionVariants.fade}>
            <label className="lp-field" htmlFor="checkout-email">
              <span>Customer email</span>
              <input
                id="checkout-email"
                onChange={(event) => setCheckoutEmail(event.target.value)}
                placeholder="buyer@company.com"
                type="email"
                value={checkoutEmail}
              />
            </label>
            <label className="lp-field" htmlFor="checkout-organization">
              <span>Organization</span>
              <input
                id="checkout-organization"
                onChange={(event) => setCheckoutOrganization(event.target.value)}
                placeholder="Company name"
                value={checkoutOrganization}
              />
            </label>
            <p className="lp-checkout-status" aria-live="polite">
              {checkoutStatus || "Buyer details are passed to the configured billing provider."}
            </p>
          </motion.div>

          <motion.div className="lp-pricing-grid" variants={motionVariants.staggerTight}>
            {visiblePlans.map((plan) => (
              <motion.article
                className={cx("lp-plan", plan.highlighted && "is-highlighted")}
                key={plan.code}
                variants={motionVariants.item}
                whileHover={reduce ? undefined : { y: -4 }}
              >
                {plan.highlighted && <span className="lp-plan-badge">Most popular</span>}
                <div className="lp-plan-head">
                  <h3>{plan.name}</h3>
                  <p>{plan.description}</p>
                </div>
                <div className="lp-plan-price">
                  <strong>${plan.price[interval]}</strong>
                  <span>/{interval === "monthly" ? "mo" : "yr"}</span>
                </div>
                <span className="lp-plan-limit">{plan.limit}</span>
                <ul className="lp-plan-features">
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Check size={16} />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <button
                  className={cx("lp-plan-cta", plan.highlighted ? "primary-button" : "secondary-button")}
                  type="button"
                  onClick={() => startCheckout(plan.code)}
                >
                  Buy {plan.name}
                </button>
              </motion.article>
            ))}
          </motion.div>
        </div>
      </motion.section>

      <motion.section
        className="lp-section lp-faq"
        id="faq"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <div className="lp-container">
          <motion.div className="lp-heading" variants={motionVariants.fade}>
            <span className="lp-section-eyebrow">FAQ</span>
            <h2>Questions teams ask before switching</h2>
            <p>Everything you need to know about running remote access from the browser.</p>
          </motion.div>
          <motion.div className="lp-faq-list" variants={motionVariants.staggerTight}>
            {faqs.map((faq, index) => {
              const isOpen = openFaq === index;
              const panelId = `lp-faq-panel-${index}`;
              const buttonId = `lp-faq-button-${index}`;
              return (
                <motion.div
                  className={cx("lp-faq-item", isOpen && "is-open")}
                  key={faq.question}
                  variants={motionVariants.item}
                >
                  <h3 className="lp-faq-question">
                    <button
                      className="lp-faq-trigger"
                      id={buttonId}
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      onClick={() => setOpenFaq(isOpen ? null : index)}
                    >
                      <span>{faq.question}</span>
                      <motion.span
                        className="lp-faq-icon"
                        aria-hidden="true"
                        animate={{ rotate: isOpen ? 180 : 0 }}
                        transition={reduce ? { duration: 0 } : { duration: 0.25, ease: EASE }}
                      >
                        <ChevronDown size={17} />
                      </motion.span>
                    </button>
                  </h3>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        className="lp-faq-answer"
                        id={panelId}
                        role="region"
                        aria-labelledby={buttonId}
                        key="content"
                        initial="collapsed"
                        animate="open"
                        exit="collapsed"
                        variants={{
                          open: { height: "auto", opacity: 1 },
                          collapsed: { height: 0, opacity: 0 }
                        }}
                        transition={reduce ? { duration: 0 } : { duration: 0.3, ease: EASE }}
                      >
                        <p className="lp-faq-answer-inner">{faq.answer}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </motion.div>
        </div>
      </motion.section>

      <motion.section
        className="lp-section lp-cta"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <motion.div className="lp-container lp-cta-inner" variants={motionVariants.fade}>
          <h2>Ready to open a shell?</h2>
          <p>Pick a package, invite your team, and connect to your first host today.</p>
          <div className="lp-cta-actions">
            <a className="primary-button large" href="#pricing">
              Choose a package
              <ArrowRight size={18} />
            </a>
            <a className="secondary-button lp-hero-secondary" href="/login">
              Sign in instead
            </a>
          </div>
        </motion.div>
      </motion.section>

      <footer className="lp-footer">
        <div className="lp-container lp-footer-grid">
          <div className="lp-footer-brand">
            <a className="lp-brand" href="/">
              <span className="brand-mark">
                <Cloud size={18} />
              </span>
              <span className="lp-brand-text">
                <span className="brand-name">Onshell.cloud</span>
                <span className="brand-domain">Browser remote access</span>
              </span>
            </a>
            <p>Audited SSH, SFTP, and RDP for teams that live in the terminal but work in the browser.</p>
          </div>
          <div className="lp-footer-col">
            <strong>Product</strong>
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="lp-footer-col">
            <strong>Account</strong>
            <a href="/login">Log in</a>
            <a href="/signup">Sign up</a>
            <a href="/console">Console</a>
          </div>
        </div>
        <div className="lp-container lp-footer-bottom">
          <p>© 2026 Onshell.cloud. All rights reserved.</p>
          <p className="lp-footer-meta">SSH · SFTP · RDP</p>
        </div>
      </footer>
    </main>
  );
}
