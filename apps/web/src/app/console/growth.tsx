"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Copy, Gift, Sparkles, TrendingUp, X } from "lucide-react";
import { cx } from "@onshell/ui";
import { consoleApi, type GrowthOverview, type UsageEntry } from "./api";

const DISMISS_KEY = "onshell-upgrade-banner-dismissed";

function formatPrice(cents: number, currency: string) {
  const amount = cents / 100;
  const formatted = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return currency === "USD" ? `$${formatted}` : `${formatted} ${currency}`;
}

/** Loads the growth overview once and exposes it to the console surfaces. */
export function useGrowth() {
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
  }, []);

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

/** Plan, live usage, upgrade path, and referral link — the billing/growth panel. */
export function PlanUsagePanel({ growth }: { growth: GrowthOverview | null }) {
  const [copied, setCopied] = useState(false);

  if (!growth) {
    return (
      <section className="panel">
        <h2 className="panel-title">Plan &amp; usage</h2>
        <p className="panel-hint">Loading your plan…</p>
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

  const plan = growth.plan;
  const trialEndsAt = growth.subscription?.trialEndsAt;

  return (
    <>
      <section className="panel gr-plan">
        <div className="gr-plan-head">
          <div>
            <h2 className="panel-title">Plan &amp; usage</h2>
            <p className="panel-hint">
              {plan ? (
                <>
                  You&apos;re on <strong>{plan.name}</strong>
                  {plan.isFree ? " — free forever" : ` · ${formatPrice(plan.priceMonthlyCents, plan.currency)}/month`}.
                  {" "}
                  Audit history is kept for {plan.auditRetentionDays} days.
                </>
              ) : (
                "No plan is assigned to this workspace yet."
              )}
            </p>
          </div>
          {plan?.isFree && <span className="gr-badge">Free</span>}
        </div>

        {trialEndsAt && (
          <p className="gr-trial">
            Trial ends {new Date(trialEndsAt).toLocaleDateString()} — add a payment method before then to keep your
            current limits.
          </p>
        )}

        <div className="gr-usage-grid">
          <UsageBar entry={growth.usage.members} label="Team members" />
          <UsageBar entry={growth.usage.hosts} label="Hosts" />
          <UsageBar entry={growth.usage.concurrentSessions} label="Concurrent sessions" />
          <UsageBar entry={growth.usage.aiMessages} label="AI messages this month" />
        </div>

        {growth.upgrade && (
          <div className="gr-upgrade">
            <div>
              <strong>
                <Sparkles aria-hidden="true" size={15} />
                Upgrade to {growth.upgrade.plan.name}
              </strong>
              <p>{growth.upgrade.plan.tagline ?? "More seats, more hosts, longer audit retention."}</p>
              <ul>
                {growth.upgrade.plan.features.slice(0, 4).map((feature) => (
                  <li key={feature}>
                    <Check aria-hidden="true" size={14} />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
            <div className="gr-upgrade-cta">
              <span className="gr-upgrade-price">
                {formatPrice(growth.upgrade.plan.priceMonthlyCents, growth.upgrade.plan.currency)}
                <small>/month</small>
              </span>
              <a className="primary-button" href="/#pricing">
                {growth.upgrade.plan.trialDays > 0
                  ? `Start ${growth.upgrade.plan.trialDays}-day trial`
                  : `Upgrade to ${growth.upgrade.plan.name}`}
              </a>
              <a className="text-link" href="/contact">
                Need something custom?
              </a>
            </div>
          </div>
        )}
      </section>

      <section className="panel gr-referral">
        <div className="gr-referral-head">
          <span className="gr-referral-icon" aria-hidden="true">
            <Gift size={18} />
          </span>
          <div>
            <h2 className="panel-title">Share Onshell, get credit</h2>
            <p className="panel-hint">
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
    </>
  );
}
