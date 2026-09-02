"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  CreditCard,
  Gift,
  Loader2,
  Sparkles,
  TrendingUp,
  TriangleAlert,
  X
} from "lucide-react";
import { cx } from "@onshell/ui";
import {
  ApiError,
  consoleApi,
  type BillingInterval,
  type ConsolePlan,
  type GrowthOverview,
  type UsageEntry
} from "./api";

const DISMISS_KEY = "onshell-upgrade-banner-dismissed";

function formatPrice(cents: number, currency: string) {
  const amount = cents / 100;
  const formatted = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return currency === "USD" ? `$${formatted}` : `${formatted} ${currency}`;
}

/** "5 seats" / "Unlimited seats" — null limits mean unlimited on every plan field. */
function formatLimit(limit: number | null, singular: string, plural = `${singular}s`) {
  if (limit === null) return `Unlimited ${plural}`;
  return `${limit} ${limit === 1 ? singular : plural}`;
}

function planPrice(plan: ConsolePlan, interval: BillingInterval) {
  return interval === "yearly" ? plan.priceYearlyCents : plan.priceMonthlyCents;
}

/** Percentage saved by paying yearly, or null when there is no discount to advertise. */
function yearlySaving(plan: ConsolePlan) {
  const twelveMonths = plan.priceMonthlyCents * 12;
  if (plan.isFree || twelveMonths === 0 || plan.priceYearlyCents >= twelveMonths) return null;
  return Math.round(((twelveMonths - plan.priceYearlyCents) / twelveMonths) * 100);
}

/** Loads the growth overview once and exposes it to the console surfaces. */
/**
 * `epoch` is a re-fetch trigger, not data. Plan, usage, and referral figures are
 * per workspace, so switching workspace has to discard them — leaving the old
 * workspace's quota on screen would have people reading the wrong limits.
 */
export function useGrowth(epoch = 0) {
  const [growth, setGrowth] = useState<GrowthOverview | null>(null);

  useEffect(() => {
    let active = true;
    void consoleApi
      .growth()
      .then((payload) => {
        if (active) setGrowth(payload);
      })
      .catch(() => {
        // Non-critical: the console works fine without the plan panel.
      });
    return () => {
      active = false;
    };
  }, [epoch]);

  return growth;
}

function UsageBar({ label, entry }: { label: string; entry: UsageEntry }) {
  const percent = entry.ratio === null ? 0 : Math.round(entry.ratio * 100);

  return (
    <div className="gr-usage">
      <div className="gr-usage-head">
        <span>{label}</span>
        <strong>
          {entry.used}
          {entry.limit === null ? " / ∞" : ` / ${entry.limit}`}
        </strong>
      </div>
      <div className="gr-usage-track" aria-hidden="true">
        <span
          className={cx(entry.atLimit && "is-full", !entry.atLimit && entry.nearLimit && "is-near")}
          style={{ width: entry.limit === null ? "8%" : `${Math.max(percent, 2)}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Dismissible upgrade nudge for the top of the console.
 *
 * Shown when the workspace is on the free tier or pressing a plan limit — the two
 * moments where an upgrade is genuinely relevant rather than just noise.
 */
export function UpgradeBanner({ growth, onOpenBilling }: { growth: GrowthOverview | null; onOpenBilling: () => void }) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // Read after mount so the server and client markup agree.
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
  }, []);

  if (dismissed || !growth?.upgrade?.shouldPrompt) return null;

  const upgrade = growth.upgrade;
  const pressing = Object.entries(growth.usage).find(([, entry]) => entry.atLimit || entry.nearLimit);
  const reasonLabels: Record<string, string> = {
    members: "team seats",
    hosts: "hosts",
    concurrentSessions: "concurrent sessions",
    aiMessages: "AI messages"
  };

  return (
    <div className="gr-banner" role="status">
      <span className="gr-banner-icon" aria-hidden="true">
        <TrendingUp size={17} />
      </span>
      <div className="gr-banner-copy">
        <strong>
          {pressing
            ? `You're close to your ${reasonLabels[pressing[0]] ?? "plan"} limit`
            : `You're on the ${growth.plan?.name ?? "Free"} plan`}
        </strong>
        <span>
          {upgrade.plan.name} raises it to {upgrade.plan.maxUsers ?? "unlimited"} users and{" "}
          {upgrade.plan.maxHosts ?? "unlimited"} hosts for{" "}
          {formatPrice(upgrade.plan.priceMonthlyCents, upgrade.plan.currency)}/month
          {upgrade.plan.trialDays > 0 ? `, with a ${upgrade.plan.trialDays}-day free trial` : ""}.
        </span>
      </div>
      <button className="primary-button gr-banner-cta" type="button" onClick={onOpenBilling}>
        See {upgrade.plan.name}
        <ArrowUpRight aria-hidden="true" size={15} />
      </button>
      <button
        className="gr-banner-dismiss"
        type="button"
        aria-label="Dismiss upgrade suggestion"
        onClick={() => {
          window.localStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
      >
        <X aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

/** What the plan card's button does, given where the workspace is today. */
type PlanAction =
  | { kind: "current" }
  | { kind: "buy"; label: string }
  | { kind: "downgrade" }
  | { kind: "forbidden" };

function resolvePlanAction(plan: ConsolePlan, growth: GrowthOverview, interval: BillingInterval): PlanAction {
  const current = growth.plan;
  const currentInterval = growth.subscription?.billingInterval?.toLowerCase();
  if (current && plan.code === current.code && currentInterval === interval) return { kind: "current" };
  if (!growth.canManageBilling) return { kind: "forbidden" };
  // Moving down a tier touches proration and data retention, so it goes through
  // a human rather than a self-serve button.
  if (plan.isFree || (current && plan.displayOrder < current.displayOrder)) return { kind: "downgrade" };
  return {
    kind: "buy",
    label:
      current && plan.code === current.code
        ? `Switch to ${interval} billing`
        : plan.trialDays > 0
          ? `Start ${plan.trialDays}-day trial`
          : `Upgrade to ${plan.name}`
  };
}

function PlanCard({
  plan,
  interval,
  growth,
  busy,
  onChoose
}: {
  plan: ConsolePlan;
  interval: BillingInterval;
  growth: GrowthOverview;
  busy: boolean;
  onChoose: (plan: ConsolePlan) => void;
}) {
  const action = resolvePlanAction(plan, growth, interval);
  const price = planPrice(plan, interval);
  const saving = interval === "yearly" ? yearlySaving(plan) : null;

  return (
    <article
      className={cx(
        "gr-card",
        action.kind === "current" && "is-current",
        action.kind !== "current" && plan.isFeatured && "is-featured"
      )}
    >
      <header className="gr-card-head">
        <h3>{plan.name}</h3>
        {action.kind === "current" ? (
          <span className="gr-badge is-current">Current</span>
        ) : (
          plan.badge && <span className="gr-badge">{plan.badge}</span>
        )}
      </header>

      <p className="gr-card-price">
        {plan.isFree ? (
          <strong>Free</strong>
        ) : (
          <>
            <strong>{formatPrice(price, plan.currency)}</strong>
            <small>/{interval === "yearly" ? "year" : "month"}</small>
          </>
        )}
      </p>
      {saving !== null && <p className="gr-card-saving">Save {saving}% versus monthly</p>}

      <p className="gr-card-tagline">{plan.tagline ?? plan.description}</p>

      <ul className="gr-card-limits">
        <li>{formatLimit(plan.maxUsers, "team member")}</li>
        <li>{formatLimit(plan.maxHosts, "host")}</li>
        <li>{formatLimit(plan.maxConcurrentSessions, "concurrent session")}</li>
        <li>{formatLimit(plan.monthlyAiMessages, "AI message")} / month</li>
        <li>{plan.auditRetentionDays} days of audit history</li>
      </ul>

      {plan.features.length > 0 && (
        <ul className="gr-card-features">
          {plan.features.slice(0, 5).map((feature) => (
            <li key={feature}>
              <Check aria-hidden="true" size={14} />
              {feature}
            </li>
          ))}
        </ul>
      )}

      <div className="gr-card-cta">
        {action.kind === "current" && (
          <button className="secondary-button" type="button" disabled>
            <Check aria-hidden="true" size={15} />
            Current plan
          </button>
        )}
        {action.kind === "buy" && (
          <button className="primary-button" type="button" disabled={busy} onClick={() => onChoose(plan)}>
            {busy ? <Loader2 aria-hidden="true" className="spin" size={15} /> : <ArrowUpRight aria-hidden="true" size={15} />}
            {busy ? "Starting…" : action.label}
          </button>
        )}
        {action.kind === "downgrade" && (
          <a className="secondary-button" href="/contact">
            Talk to us about switching
          </a>
        )}
        {action.kind === "forbidden" && (
          <button className="secondary-button" type="button" disabled title="Only owners and admins can change the plan">
            Owner only
          </button>
        )}
      </div>
    </article>
  );
}

/** Plan, live usage, upgrade path, and referral link — the billing/growth panel. */
export function PlanUsagePanel({ growth }: { growth: GrowthOverview | null }) {
  const [copied, setCopied] = useState(false);
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; message: string } | null>(null);

  // Sort defensively: displayOrder is admin-editable, so do not rely on the
  // API's ordering to line the cards up cheapest-first.
  const plans = useMemo(
    () => [...(growth?.plans ?? [])].sort((a, b) => a.displayOrder - b.displayOrder),
    [growth?.plans]
  );
  const anyYearlyDiscount = useMemo(() => plans.some((plan) => yearlySaving(plan) !== null), [plans]);

  if (!growth) {
    return (
      <section className="panel gr-loading">
        <Loader2 aria-hidden="true" className="spin" size={18} />
        <p>Loading your plan…</p>
      </section>
    );
  }

  async function copyReferral() {
    try {
      await navigator.clipboard.writeText(growth!.referral.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked by permissions; the input below is selectable.
    }
  }

  async function choosePlan(plan: ConsolePlan) {
    setPendingPlan(plan.code);
    setNotice(null);
    try {
      const result = await consoleApi.startCheckout({ planCode: plan.code, billingInterval: interval });
      if (result.checkoutUrl) {
        // Hand off to the payment provider's hosted page.
        window.location.href = result.checkoutUrl;
        return;
      }
      setNotice({
        tone: "info",
        message: result.message ?? `We've logged your request to move to ${plan.name}.`
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof ApiError && error.status === 403
            ? "Only workspace owners and admins can change the plan."
            : "Could not start the upgrade. Please try again, or contact us if it keeps failing."
      });
    } finally {
      setPendingPlan(null);
    }
  }

  const plan = growth.plan;
  const subscription = growth.subscription;
  const trialEndsAt = subscription?.trialEndsAt;

  return (
    <div className="gr-stack">
      <section className="panel gr-plan">
        <div className="gr-plan-head">
          <div className="gr-plan-id">
            <span className="gr-plan-icon" aria-hidden="true">
              <CreditCard size={19} />
            </span>
            <div>
              <h2>Current plan</h2>
              <p className="gr-plan-name">
                {plan?.name ?? "No plan assigned"}
                {plan?.isFree && <span className="gr-badge">Free forever</span>}
                {subscription?.status === "TRIALING" && <span className="gr-badge is-warn">Trial</span>}
              </p>
              <p className="gr-plan-note">
                {plan
                  ? `${plan.tagline ?? plan.description} · Audit history kept for ${plan.auditRetentionDays} days.`
                  : "This workspace has no subscription yet — pick a plan below to get started."}
              </p>
            </div>
          </div>
          {plan && !plan.isFree && (
            <p className="gr-plan-price">
              <strong>{formatPrice(plan.priceMonthlyCents, plan.currency)}</strong>
              <small>/month</small>
            </p>
          )}
        </div>

        {trialEndsAt && (
          <p className="gr-trial">
            <TriangleAlert aria-hidden="true" size={15} />
            Trial ends {new Date(trialEndsAt).toLocaleDateString()} — add a payment method before then to keep your
            current limits.
          </p>
        )}

        {subscription?.currentPeriodEnd && !trialEndsAt && (
          <p className="gr-plan-renews">
            {subscription.cancelAt
              ? `Cancels on ${new Date(subscription.cancelAt).toLocaleDateString()}.`
              : `Renews on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}, billed ${subscription.billingInterval.toLowerCase()}.`}
          </p>
        )}
      </section>

      <section className="panel gr-usage-panel">
        <header className="gr-section-head">
          <div>
            <h2>Usage</h2>
            <p>What this workspace is consuming against the current plan&apos;s limits.</p>
          </div>
        </header>
        <div className="gr-usage-grid">
          <UsageBar entry={growth.usage.members} label="Team members" />
          <UsageBar entry={growth.usage.hosts} label="Hosts" />
          <UsageBar entry={growth.usage.concurrentSessions} label="Concurrent sessions" />
          <UsageBar entry={growth.usage.aiMessages} label="AI messages this month" />
        </div>
      </section>

      {plans.length > 0 && (
        <section className="panel gr-plans">
          <header className="gr-section-head">
            <div>
              <h2>Plans</h2>
              <p>
                {growth.canManageBilling
                  ? "Change plan whenever you like — limits apply the moment the payment clears."
                  : "Only workspace owners and admins can change the plan."}
              </p>
            </div>
            <div className="gr-interval" role="group" aria-label="Billing interval">
              <button
                aria-pressed={interval === "monthly"}
                className={cx(interval === "monthly" && "is-active")}
                type="button"
                onClick={() => setInterval("monthly")}
              >
                Monthly
              </button>
              <button
                aria-pressed={interval === "yearly"}
                className={cx(interval === "yearly" && "is-active")}
                type="button"
                onClick={() => setInterval("yearly")}
              >
                Yearly
                {anyYearlyDiscount && <span className="gr-interval-hint">Save more</span>}
              </button>
            </div>
          </header>

          {notice && (
            <p className={cx("gr-notice", notice.tone === "error" && "is-error")} role="status">
              {notice.tone === "error" ? <TriangleAlert aria-hidden="true" size={15} /> : <Sparkles aria-hidden="true" size={15} />}
              {notice.message}
            </p>
          )}

          <div className="gr-plan-grid">
            {plans.map((entry) => (
              <PlanCard
                busy={pendingPlan === entry.code}
                growth={growth}
                interval={interval}
                key={entry.code}
                onChoose={(chosen) => void choosePlan(chosen)}
                plan={entry}
              />
            ))}
          </div>

          <p className="gr-plans-foot">
            Need more seats, an invoice, or on-premise deployment?{" "}
            <a className="text-link" href="/contact">
              Talk to us
            </a>
            .
          </p>
        </section>
      )}

      <section className="panel gr-referral">
        <div className="gr-referral-head">
          <span className="gr-referral-icon" aria-hidden="true">
            <Gift size={18} />
          </span>
          <div>
            <h2>Share Onshell, get credit</h2>
            <p>
              Send your link to someone still SSHing from a laptop. We credit you for every workspace that signs up
              through it — {growth.referral.signups === 0 ? "no signups yet" : `${growth.referral.signups} so far`}.
            </p>
          </div>
        </div>

        <div className="gr-referral-row">
          <input readOnly value={growth.referral.url} aria-label="Your referral link" onFocus={(event) => event.target.select()} />
          <button className="secondary-button" type="button" onClick={() => void copyReferral()}>
            {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>

        <div className="gr-referral-share">
          <span>Share via</span>
          <a
            href={`https://twitter.com/intent/tweet?${new URLSearchParams({
              text: "I've stopped keeping SSH keys on my laptop — Onshell.cloud runs audited terminals, SFTP, and RDP straight from the browser. Free for one user:",
              url: growth.referral.url
            }).toString()}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            X / Twitter
          </a>
          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(growth.referral.url)}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            LinkedIn
          </a>
          <a
            href={`mailto:?subject=${encodeURIComponent("A browser-based SSH client worth a look")}&body=${encodeURIComponent(
              `I've been using Onshell.cloud for server access — audited terminals, SFTP, and RDP from the browser, with keys stored encrypted instead of on every laptop. Free for one user: ${growth.referral.url}`
            )}`}
          >
            Email
          </a>
        </div>
      </section>
    </div>
  );
}
