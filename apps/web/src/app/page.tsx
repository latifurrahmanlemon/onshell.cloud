"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  Braces,
  Check,
  ChevronDown,
  FileLock2,
  HeartHandshake,
  KeyRound,
  ListTodo,
  MonitorUp,
  ScrollText,
  ShieldCheck,
  SquareTerminal
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { cx } from "@onshell/ui";
import { PublicFooter, PublicNav } from "../components/public-shell";
import { TurnstileWidget, useTurnstile } from "../components/turnstile";
import { apiBaseUrl, site, siteUrl as SITE_URL } from "../lib/site";
import "./home.css";

/**
 * Fallback pricing, used only until GET /plans resolves. Kept in sync with the
 * seed so a cold cache or an unreachable API still renders honest numbers.
 */
const plans = [
  {
    code: "free",
    name: "Free",
    price: { monthly: 0, yearly: 0 },
    limit: "1 user / 3 hosts",
    description: "Everything you need to replace a desktop SSH client, for one person.",
    badge: "Free forever",
    isFree: true,
    features: [
      "1 user",
      "Up to 3 hosts",
      "Browser SSH terminal",
      "SFTP file manager",
      "Encrypted credential vault",
      "7-day audit history"
    ]
  },
  {
    code: "team",
    name: "Team",
    price: { monthly: 19, yearly: 190 },
    limit: "10 users / 50 hosts",
    description: "For small teams sharing servers. Billed per workspace, not per seat.",
    badge: "Most popular",
    highlighted: true,
    features: [
      "Up to 10 users",
      "Everything in Free",
      "Browser RDP sessions",
      "Shared team snippets",
      "Role-based host permissions",
      "90-day audit retention"
    ]
  },
  {
    code: "business",
    name: "Business",
    price: { monthly: 49, yearly: 490 },
    limit: "50 users / 300 hosts",
    description: "For growing DevOps organisations that need governance and scale.",
    features: [
      "Up to 50 users",
      "Everything in Team",
      "Unlimited AI assistant",
      "365-day audit retention",
      "SAML / OIDC ready",
      "Priority support"
    ]
  }
];

const featureCards = [
  {
    icon: SquareTerminal,
    title: "Full browser SSH terminal",
    text: "A real xterm in a tab: 256 colours, resizing, scrollback, and every control sequence. vim, tmux, and htop behave exactly as they do locally."
  },
  {
    icon: FileLock2,
    title: "SFTP file manager",
    text: "Browse, upload, download, and edit remote files on the same host, with per-user permission checks on every operation."
  },
  {
    icon: MonitorUp,
    title: "RDP for Windows hosts",
    text: "Launch Windows desktops through controlled gateway sessions — policy-bound and recorded alongside your shell sessions."
  },
  {
    icon: KeyRound,
    title: "Encrypted credential vault",
    text: "Keys and passwords sealed with AES-256-GCM. Members connect through a credential without ever being shown the secret."
  },
  {
    icon: Braces,
    title: "Shared team snippets",
    text: "Keep reviewed one-liners and runbooks next to the hosts they belong to, so routine work stays consistent."
  },
  {
    icon: Bot,
    title: "Built-in AI assistant",
    text: "Ask about a stubborn systemd unit or an Onshell setting and get a practical answer, without leaving the console."
  },
  {
    icon: ShieldCheck,
    title: "Roles and per-host access",
    text: "Five roles from Owner to Auditor. Developers reach staging, auditors read the trail, production stays locked down."
  },
  {
    icon: ScrollText,
    title: "Complete audit trail",
    text: "Every session, transfer, and admin change recorded with actor, IP, and timestamp. Retention follows your plan."
  },
  {
    icon: ListTodo,
    title: "Workspace task manager",
    text: "Capture maintenance follow-ups where the work happens, search and filter the queue, and keep progress synced across browser and desktop."
  }
];

const steps = [
  {
    number: "01",
    title: "Register your hosts",
    text: "Add each server's address, port, and username once. No agent to deploy — anything you can already reach over SSH works as-is."
  },
  {
    number: "02",
    title: "Store credentials once",
    text: "Paste keys or passwords into the encrypted vault and attach them to hosts. Nobody has to keep a copy on their laptop again."
  },
  {
    number: "03",
    title: "Invite your team",
    text: "Assign roles and per-host access. Members sign in with email, Google, or a 2FA-protected account."
  },
  {
    number: "04",
    title: "Work from any browser",
    text: "Open terminals, move files, and launch desktops from any machine with a browser — every action audited."
  }
];

const stats = [
  { value: "3-in-1", label: "SSH · SFTP · RDP" },
  { value: "$0", label: "To start, forever" },
  { value: "100%", label: "Sessions audited" },
  { value: "AES-256", label: "Vault encryption" }
];

/** Problem/solution pairs — the objections a team raises before switching. */
const painPoints = [
  {
    problem: "Private keys scattered across every laptop",
    solution: "Keys live encrypted in one vault. The gateway injects them; members never hold the material."
  },
  {
    problem: "Offboarding means hunting for who had which key",
    solution: "Revoke one membership. Access to every host disappears with it, and the audit log shows what they touched."
  },
  {
    problem: "Nobody can answer \"who ran that on Tuesday?\"",
    solution: "Every session, transfer, and permission change is recorded with actor, IP, and timestamp."
  },
  {
    problem: "New engineers lose a day to SSH config",
    solution: "They sign in and see the hosts they're allowed to reach. Setup time is a single invite."
  }
];

const faqs = [
  {
    question: "What is Onshell.cloud?",
    answer:
      "Onshell.cloud is a browser-based SSH client for teams. Register your servers once, store their keys and passwords in an encrypted vault, then open full audited terminals, SFTP file browsers, or RDP desktops from any browser tab — with per-host permissions and a complete audit trail, and nothing to install."
  },
  {
    question: "Is Onshell.cloud really free?",
    answer:
      "Yes. The Free plan is free forever for one person: up to 3 hosts, browser SSH, SFTP, the encrypted credential vault, and 7 days of audit history, with no credit card. It is a permanent tier, not a trial. Paid Team and Business plans add seats, hosts, RDP, snippets, and longer retention — and those come with a separate 14-day trial."
  },
  {
    question: "Do I need to install any software or agents?",
    answer:
      "No. Everything runs in the browser through the Onshell gateway. There are no desktop clients, browser extensions, or per-host agents to deploy — any host you can already reach with a normal SSH client works as-is."
  },
  {
    question: "How are my credentials and keys kept safe?",
    answer:
      "SSH keys and passwords are encrypted at rest with AES-256-GCM, using a master key held only in the server environment. Every connection is brokered through the gateway, so key material is never serialised into the browser and members connect without ever seeing the secret."
  },
  {
    question: "Does the terminal support vim, tmux, and colours?",
    answer:
      "Yes. It is a full xterm implementation, so 256-colour output, alternate screen buffers, mouse reporting, and resizing all work. Interactive tools behave exactly as they do in a local terminal."
  },
  {
    question: "Which protocols and platforms are supported?",
    answer:
      "SSH and SFTP for Linux and Unix hosts, plus RDP for Windows desktops. A single registered host can be opened as a terminal, a file browser, or a remote desktop, depending on what it supports."
  },
  {
    question: "Can I control who accesses which servers?",
    answer:
      "Yes. Five roles from Owner to Auditor, with per-host permissions, so each member only reaches the systems they should. Sign-in supports email, Google, and two-factor authentication via an authenticator app or emailed codes."
  },
  {
    question: "What gets logged for audit and compliance?",
    answer:
      "Every session, file transfer, permission change, and admin action is recorded with actor, IP, and timestamp in an append-only log. Retention matches your plan — 7 days on Free, 90 days on Team, and a full year on Business."
  },
  {
    question: "What does the AI assistant do?",
    answer:
      "It answers questions about Onshell.cloud itself and about practical Linux, shell, and SSH work — commands, config files, key management, systemd, and troubleshooting — from inside the console. Conversations are saved as threads so you can pick up where you left off. It never asks for or repeats your secrets."
  },
  {
    question: "How does billing work?",
    answer:
      "Paid plans are billed per workspace rather than per seat, monthly or yearly, with yearly including two months free. You can upgrade or downgrade at any time, and larger deployments are arranged directly — just get in touch."
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
  tagline?: string | null;
  badge?: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  maxUsers?: number | null;
  maxHosts?: number | null;
  isFree?: boolean;
  isFeatured?: boolean;
  trialDays?: number;
  features: string[];
}

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

/**
 * Structured data for search engines and AI crawlers, rendered as JSON-LD in the
 * initial HTML so it is present without JavaScript.
 *
 * The `@id` anchors here are referenced by the secondary pages (`/security`,
 * `/browser-ssh-client`, `/contact`), which lets crawlers resolve one
 * Organization and one WebSite entity across the whole site instead of treating
 * each page as an unrelated island.
 */
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: site.legalName,
      alternateName: site.name,
      url: SITE_URL,
      logo: {
        "@type": "ImageObject",
        url: `${SITE_URL}/icons/icon-512.png`,
        width: 512,
        height: 512
      },
      description:
        "Onshell.cloud builds a browser-based SSH client for teams: audited terminals, SFTP, and RDP with an encrypted credential vault and a complete audit trail.",
      email: site.supportEmail,
      foundingDate: String(site.foundedYear),
      contactPoint: [
        { "@type": "ContactPoint", contactType: "customer support", email: site.supportEmail },
        { "@type": "ContactPoint", contactType: "sales", email: site.salesEmail }
      ]
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: site.name,
      description: "The best browser-based SSH client for teams.",
      publisher: { "@id": `${SITE_URL}/#organization` },
      inLanguage: "en"
    },
    {
      "@type": "WebPage",
      "@id": `${SITE_URL}/#webpage`,
      url: SITE_URL,
      name: "Onshell.cloud — the best browser-based SSH client for teams",
      isPartOf: { "@id": `${SITE_URL}/#website` },
      about: { "@id": `${SITE_URL}/#software` },
      primaryImageOfPage: { "@id": `${SITE_URL}/#logo` }
    },
    {
      "@type": ["SoftwareApplication", "WebApplication"],
      "@id": `${SITE_URL}/#software`,
      name: site.name,
      alternateName: "Onshell browser SSH client",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "SSH client",
      operatingSystem: "Any (runs in a web browser)",
      browserRequirements: "Requires a modern browser with WebSocket support",
      url: SITE_URL,
      description:
        "A browser-based SSH client for teams. Open full audited terminals, manage files over SFTP, and launch RDP desktops from any browser tab, with keys stored in an encrypted vault and every session recorded.",
      featureList: featureCards.map((card) => card.title),
      softwareHelp: { "@id": `${SITE_URL}/browser-ssh-client#webpage` },
      publisher: { "@id": `${SITE_URL}/#organization` },
      // A free tier plus paid tiers, expressed so crawlers can read "free to
      // start" without us inventing a review score we do not have.
      offers: {
        "@type": "AggregateOffer",
        priceCurrency: "USD",
        lowPrice: 0,
        highPrice: 49,
        offerCount: plans.length,
        offers: plans.map((plan) => ({
          "@type": "Offer",
          name: plan.name,
          price: plan.price.monthly,
          priceCurrency: "USD",
          description: plan.description,
          url: `${SITE_URL}/#pricing`,
          availability: "https://schema.org/InStock"
        }))
      }
    },
    {
      "@type": "HowTo",
      "@id": `${SITE_URL}/#howto`,
      name: "How to get audited SSH access for your team in your browser",
      description:
        "Register your hosts, store credentials in the encrypted vault, invite your team with per-host roles, and open terminals from any browser.",
      totalTime: "PT15M",
      step: steps.map((step, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        name: step.title,
        text: step.text
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
  const [selectedPlanCode, setSelectedPlanCode] = useState<string>();
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const checkoutRef = useRef<HTMLDivElement>(null);
  const checkoutEmailRef = useRef<HTMLInputElement>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const checkoutTurnstile = useTurnstile("checkout");

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
          badge: plan.badge ?? undefined,
          features: plan.features,
          isFree: plan.isFree ?? false,
          trialDays: plan.trialDays ?? 0,
          // The admin panel owns which card is highlighted, via Plan.isFeatured.
          highlighted: plan.isFeatured ?? false
        }))
      : plans.map((plan) => ({ ...plan, trialDays: plan.code === "free" ? 0 : 14 }));

  /** Free tier needs no payment provider — send people straight to signup. */
  function planCta(plan: { code: string; isFree?: boolean; name: string }) {
    if (plan.isFree) return { label: "Start free", href: "/signup" as const };
    return { label: `Start ${plan.name} trial`, href: undefined };
  }

  async function startCheckout(planCode: string) {
    if (!checkoutEmail || !checkoutOrganization) {
      setCheckoutStatus("Enter your email and organization name to continue to checkout.");
      return;
    }

    setCheckoutBusy(true);
    setCheckoutStatus("Preparing checkout…");
    try {
      const response = await fetch(`${apiBaseUrl}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planCode,
          billingInterval: interval,
          email: checkoutEmail,
          organizationName: checkoutOrganization,
          ...(checkoutTurnstile.token ? { turnstileToken: checkoutTurnstile.token } : {})
        })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Single-use token: a retry needs a fresh challenge.
        checkoutTurnstile.reset();
        setCheckoutStatus(payload.message ?? "Checkout failed. Please try again.");
        return;
      }

      if (payload.checkoutUrl) {
        setCheckoutStatus(`Redirecting to ${payload.provider ?? "checkout"}…`);
        window.location.href = payload.checkoutUrl;
        return;
      }

      setCheckoutStatus(
        "Card payments aren't switched on yet — start on the Free plan and we'll upgrade you manually, or get in touch."
      );
    } catch {
      checkoutTurnstile.reset();
      setCheckoutStatus("Checkout service is not reachable. Please try again shortly.");
    } finally {
      setCheckoutBusy(false);
    }
  }

  function selectPaidPlan(planCode: string) {
    setSelectedPlanCode(planCode);
    setCheckoutStatus("");
    requestAnimationFrame(() => {
      checkoutRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      window.setTimeout(() => checkoutEmailRef.current?.focus({ preventScroll: true }), reduce ? 0 : 350);
    });
  }

  return (
    <main className="lp-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <PublicNav />

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
              Free forever for one user — no card required
            </motion.span>
            <motion.h1 id="lp-hero-title" variants={motionVariants.fade}>
              The best <span className="lp-grad-text">browser-based SSH client</span> for teams.
            </motion.h1>
            <motion.p className="lp-hero-lead" variants={motionVariants.fade}>
              Open a full audited terminal in a browser tab, move files over SFTP, and reach Windows desktops over RDP.
              Keys stay encrypted in one vault, access is granted per host, and every session is recorded. Nothing to
              install — on any operating system.
            </motion.p>
            <motion.div className="lp-hero-actions" variants={motionVariants.fade}>
              <a className="primary-button large" href="/signup">
                Start free
                <ArrowRight size={18} />
              </a>
              <a className="secondary-button lp-hero-secondary" href="/browser-ssh-client">
                How it works
              </a>
            </motion.div>
            <motion.p className="lp-hero-trust" variants={motionVariants.fade}>
              No agents to install · AES-256 encrypted vault · Every session audited
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
            <h2>A browser SSH client that replaces your whole access stack</h2>
            <p>Nine capabilities that usually take a stack of separate tools — behind one login, one policy, one audit trail.</p>
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
        className="lp-section lp-task-feature"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <div className="lp-container lp-task-layout">
          <motion.div className="lp-task-copy" variants={motionVariants.fade}>
            <span className="lp-section-eyebrow">Operational follow-through</span>
            <h2>Turn “we should fix that” into work that gets finished</h2>
            <p>Keep the small but important jobs beside the hosts, credentials, and sessions they came from. Everyone sees one focused queue on web and desktop.</p>
            <ul>
              <li><Check size={16}/>Capture a follow-up in seconds</li>
              <li><Check size={16}/>Filter open and completed work</li>
              <li><Check size={16}/>Search the shared history anytime</li>
            </ul>
            <a className="secondary-button" href="/signup">Start organising free <ArrowRight size={16}/></a>
          </motion.div>
          <motion.div className="lp-task-preview" variants={motionVariants.item} aria-label="Task manager preview">
            <header><span><ListTodo size={16}/>Workspace tasks</span><strong>67% complete</strong></header>
            <div className="lp-task-preview-progress"><i/></div>
            <article className="is-done"><Check size={14}/><div><strong>Rotate staging deploy key</strong><small>Completed today</small></div></article>
            <article><span/><div><strong>Review production disk alert</strong><small>Added 18 minutes ago</small></div></article>
            <article><span/><div><strong>Document backup restore steps</strong><small>Added yesterday</small></div></article>
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
            <h2>From bare servers to audited access in fifteen minutes</h2>
            <p>Four steps, no agents, and nothing to install on the machine you&apos;re sitting at.</p>
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

      {/* Placed after "how it works" and before pricing on purpose: both of these
          are reasons to choose the product, and a reader who has just understood
          the mechanism is the one most likely to care that they can check it and
          that there is a native app. */}
      <motion.section
        className="lp-section lp-desktop"
        id="desktop"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <div className="lp-container">
          <motion.div className="lp-heading" variants={motionVariants.fade}>
            <span className="lp-section-eyebrow">Onshell Desktop</span>
            <h2>Or skip the browser entirely</h2>
            <p>
              A free, open-source app for Windows, macOS, and Linux — with two things a browser tab
              structurally cannot do.
            </p>
          </motion.div>

          <motion.div className="lp-desktop-grid" variants={motionVariants.staggerTight}>
            <motion.article className="lp-desktop-card" variants={motionVariants.item}>
              <SquareTerminal aria-hidden="true" size={20} />
              <h3>Your own computer&apos;s terminal</h3>
              <p>
                A browser cannot spawn a process on the machine it runs on — that is the sandbox the web
                rests on. The app opens a real PowerShell, zsh, bash, or WSL shell next to your servers,
                with no network in the path at all.
              </p>
            </motion.article>

            <motion.article className="lp-desktop-card" variants={motionVariants.item}>
              <ShieldCheck aria-hidden="true" size={20} />
              <h3>Connections that stay yours</h3>
              <p>
                A browser cannot speak SSH, so every browser-based client relays through a server that
                sees the credential. The desktop app dials port 22 itself: we authorise the session and
                record it, but we are not on the wire and cannot be.
              </p>
            </motion.article>

            <motion.article className="lp-desktop-card" variants={motionVariants.item}>
              <FileLock2 aria-hidden="true" size={20} />
              <h3>The same team workspace</h3>
              <p>
                Hosts, the encrypted vault, per-person access, snippets, and the audit log are shared with
                everyone else — the app is another way into the same workspace, not a separate island of
                config on one laptop.
              </p>
            </motion.article>
          </motion.div>

          <motion.div className="lp-desktop-actions" variants={motionVariants.fade}>
            <a className="primary-button large" href="/desktop">
              What the desktop app does
              <ArrowRight aria-hidden="true" size={18} />
            </a>
            <a className="secondary-button" href="/download">
              Download for your platform
            </a>
          </motion.div>
        </div>
      </motion.section>

      <motion.section
        className="lp-section lp-open"
        id="open-source"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <div className="lp-container lp-open-inner">
          <motion.div variants={motionVariants.fade}>
            <span className="lp-section-eyebrow">Open source</span>
            <h2>Don&apos;t trust us — read it</h2>
            <p>
              You are being asked to hand this software the credentials to your servers. That is not a thing
              anyone should do on the strength of a marketing page, so the whole platform is public under the{" "}
              {site.licenseName}: the credential vault, the session broker, the gateway, the agent, and the
              desktop app. Not a client library with the interesting parts held back.
            </p>
            <p>
              Want to know what happens to your private key between pasting it and a shell opening? Go and
              read that file. Would you rather nobody else held it at all? Self-host — there is no licence
              key and no feature kept back for the hosted version.
            </p>
            <div className="lp-open-actions">
              <a className="primary-button" href={site.repoUrl} rel="noreferrer" target="_blank">
                View the source
                <ArrowRight aria-hidden="true" size={17} />
              </a>
              <a className="secondary-button" href="/security">
                How we handle credentials
              </a>
            </div>
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
              <h2>Start free. Upgrade when your team grows.</h2>
              <p>
                One genuinely useful free tier for solo operators, then per-workspace pricing for teams — not per seat.
              </p>
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

          <motion.div className="lp-pricing-grid" variants={motionVariants.staggerTight}>
            {visiblePlans.map((plan) => {
              const cta = planCta(plan);
              return (
                <motion.article
                  className={cx("lp-plan", plan.highlighted && "is-highlighted", plan.isFree && "is-free", selectedPlanCode === plan.code && "is-selected")}
                  key={plan.code}
                  variants={motionVariants.item}
                  whileHover={reduce ? undefined : { y: -4 }}
                >
                  {plan.badge && <span className="lp-plan-badge">{plan.badge}</span>}
                  <div className="lp-plan-head">
                    <h3>{plan.name}</h3>
                    <p>{plan.description}</p>
                  </div>
                  <div className="lp-plan-price">
                    {plan.isFree ? (
                      <>
                        <strong>$0</strong>
                        <span>forever</span>
                      </>
                    ) : (
                      <>
                        <strong>${plan.price[interval]}</strong>
                        <span>/{interval === "monthly" ? "mo" : "yr"}</span>
                      </>
                    )}
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
                  {cta.href ? (
                    <a className={cx("lp-plan-cta", "primary-button")} href={cta.href}>
                      {cta.label}
                    </a>
                  ) : (
                    <button
                      className={cx("lp-plan-cta", plan.highlighted ? "primary-button" : "secondary-button")}
                      type="button"
                      aria-pressed={selectedPlanCode === plan.code}
                      onClick={() => selectPaidPlan(plan.code)}
                    >
                      {cta.label}
                    </button>
                  )}
                  <span className="lp-plan-note">
                    {plan.isFree
                      ? "No credit card, no time limit"
                      : plan.trialDays > 0
                        ? `${plan.trialDays}-day free trial, cancel anytime`
                        : "Cancel anytime"}
                  </span>
                </motion.article>
              );
            })}
          </motion.div>

          {/* Checkout details, only relevant once a paid plan is chosen. Kept
              below the grid so the Free CTA is never gated behind a form. */}
          <motion.div className={cx("lp-checkout", selectedPlanCode && "is-active")} variants={motionVariants.fade} ref={checkoutRef}>
            <div className="lp-checkout-head">
              <strong>{selectedPlanCode ? `Continue with ${visiblePlans.find((plan) => plan.code === selectedPlanCode)?.name ?? "selected plan"}` : "Choose Team or Business above"}</strong>
              <span>{selectedPlanCode ? `${interval === "yearly" ? "Yearly" : "Monthly"} billing selected. We’ll pass these details securely to the billing provider.` : "Select a paid package first, then enter your details."}</span>
            </div>
            <div className="lp-checkout-fields">
              <label className="lp-field" htmlFor="checkout-email">
                <span>Your email</span>
                <input
                  id="checkout-email"
                  ref={checkoutEmailRef}
                  onChange={(event) => setCheckoutEmail(event.target.value)}
                  placeholder="you@company.com"
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
            </div>
            <TurnstileWidget key={checkoutTurnstile.widgetKey} {...checkoutTurnstile.widgetProps} />
            <button className="primary-button lp-checkout-submit" type="button" disabled={!selectedPlanCode || checkoutBusy} onClick={() => selectedPlanCode && void startCheckout(selectedPlanCode)}>
              {checkoutBusy ? "Preparing checkout…" : selectedPlanCode ? `Continue with ${visiblePlans.find((plan) => plan.code === selectedPlanCode)?.name ?? "plan"}` : "Select a package above"}
              {!checkoutBusy && <ArrowRight aria-hidden="true" size={17} />}
            </button>
            <p className="lp-checkout-legal">
              Payment is collected by {site.legalName}, operator of {site.name}. By continuing, you agree to our <a href="/terms">Terms</a> and acknowledge our <a href="/privacy">Privacy Policy</a> and <a href="/refund-policy">Refund Policy</a>.
            </p>
            <p className="lp-checkout-status" aria-live="polite">
              {checkoutStatus ||
                "Need more than 50 users or custom retention? Talk to us about Enterprise instead."}
            </p>
          </motion.div>

          {/* Enterprise is a sales conversation, not a self-serve plan, so it
              deliberately sits outside the pricing grid. */}
          <motion.div className="lp-enterprise" variants={motionVariants.fade}>
            <div>
              <h3>Enterprise</h3>
              <p>
                More than 50 users, custom audit retention, SSO enforcement, data-residency requirements, or a security
                review to get through? We&apos;ll size it with you.
              </p>
            </div>
            <a className="secondary-button" href="/contact">
              Talk to us
              <ArrowRight size={16} />
            </a>
          </motion.div>
        </div>
      </motion.section>

      <motion.section
        className="lp-section lp-pains"
        aria-labelledby="lp-pains-title"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <div className="lp-container">
          <motion.div className="lp-heading" variants={motionVariants.fade}>
            <span className="lp-section-eyebrow">Why teams switch</span>
            <h2 id="lp-pains-title">The problems desktop SSH clients leave you with</h2>
          </motion.div>
          <motion.div className="lp-pain-grid" variants={motionVariants.staggerTight}>
            {painPoints.map((pain) => (
              <motion.div className="lp-pain" key={pain.problem} variants={motionVariants.item}>
                <p className="lp-pain-problem">{pain.problem}</p>
                <p className="lp-pain-solution">
                  <Check aria-hidden="true" size={15} />
                  <span>{pain.solution}</span>
                </p>
              </motion.div>
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
        className="lp-section lp-support"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <motion.div className="lp-container lp-support-inner" variants={motionVariants.fade}>
          <span className="lp-support-icon"><HeartHandshake aria-hidden="true" size={22} /></span>
          <div>
            <span className="lp-section-eyebrow">Community supported</span>
            <h2>Onshell helped? Buy the project a coffee.</h2>
            <p>Make a one-time donation from $1. No account, subscription, or login required.</p>
          </div>
          <a className="secondary-button large" href="/donate?source=website">Support Onshell</a>
        </motion.div>
      </motion.section>

      <motion.section
        className="lp-section lp-cta"
        variants={motionVariants.stagger}
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT}
      >
        <motion.div className="lp-container lp-cta-inner" variants={motionVariants.fade}>
          <h2>Open your first browser terminal in five minutes</h2>
          <p>Free forever for one person. No credit card, no agents to deploy, no config to copy around.</p>
          <div className="lp-cta-actions">
            <a className="primary-button large" href="/signup">
              Start free
              <ArrowRight size={18} />
            </a>
            <a className="secondary-button lp-hero-secondary" href="/contact">
              Talk to us first
            </a>
          </div>
        </motion.div>
      </motion.section>

      <PublicFooter />
    </main>
  );
}
