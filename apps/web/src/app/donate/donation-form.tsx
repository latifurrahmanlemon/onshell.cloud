"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, CheckCircle2, Coffee, Loader2 } from "lucide-react";
import { TurnstileWidget, useTurnstile } from "../../components/turnstile";
import { apiBaseUrl } from "../../lib/site";

const presets = [3, 5, 10, 25];

export function DonationForm({
  initialStatus,
  sessionId,
  source,
}: {
  initialStatus?: "success" | "cancelled";
  sessionId?: string;
  source: "website" | "download" | "desktop";
}) {
  const [amount, setAmount] = useState("5");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const turnstile = useTurnstile("checkout");
  const amountNumber = Number(amount);
  const validAmount =
    Number.isFinite(amountNumber) &&
    amountNumber >= 1 &&
    amountNumber <= 999_999.99;
  const amountLabel = useMemo(
    () =>
      validAmount
        ? new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(amountNumber)
        : "$0.00",
    [amountNumber, validAmount],
  );

  useEffect(() => {
    if (initialStatus !== "success" || !sessionId) return;
    void fetch(`${apiBaseUrl}/payments/stripe/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).then((response) => {
      if (!response.ok) setError("Your payment is still being confirmed. Please refresh in a moment.");
    }).catch(() => {
      setError("Your payment is safe, but confirmation is delayed. Please refresh in a moment.");
    });
  }, [initialStatus, sessionId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!validAmount) {
      setError("Enter an amount from $1 to $999,999.99.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/donations/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents: Math.round(amountNumber * 100),
          donorName: name.trim() || undefined,
          donorEmail: email.trim() || undefined,
          message: message.trim() || undefined,
          source,
          ...(turnstile.token ? { turnstileToken: turnstile.token } : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        checkoutUrl?: string;
        message?: string;
      };
      if (!response.ok || !payload.checkoutUrl) {
        turnstile.reset();
        setError(
          payload.message ??
            "Could not start the secure checkout. Please try again.",
        );
        setBusy(false);
        return;
      }
      window.location.assign(payload.checkoutUrl);
    } catch {
      turnstile.reset();
      setError(
        "Cannot reach the payment service. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <form className="donate-form" onSubmit={submit} noValidate>
      <div className="donate-form-head">
        <div>
          <span className="lp-section-eyebrow">One-time donation</span>
          <h2 id="donation-form-title">Choose your amount</h2>
        </div>
        <Coffee aria-hidden="true" size={24} />
      </div>

      {initialStatus === "success" && (
        <div className="donate-notice is-success" role="status">
          <CheckCircle2 aria-hidden="true" size={19} />
          <span>
            <strong>Thank you for supporting Onshell.</strong> Stripe is
            confirming your contribution.
          </span>
        </div>
      )}
      {initialStatus === "cancelled" && (
        <div className="donate-notice" role="status">
          Checkout was cancelled. Nothing was charged.
        </div>
      )}

      <div
        className="donate-presets"
        role="group"
        aria-label="Suggested donation amounts"
      >
        {presets.map((preset) => (
          <button
            aria-pressed={amountNumber === preset}
            className={amountNumber === preset ? "is-active" : ""}
            key={preset}
            onClick={() => setAmount(String(preset))}
            type="button"
          >
            ${preset}
          </button>
        ))}
      </div>

      <label className="donate-field" htmlFor="donation-amount">
        <span>Custom amount (USD)</span>
        <span className="donate-amount-wrap">
          <span aria-hidden="true">$</span>
          <input
            aria-describedby="donation-amount-help"
            id="donation-amount"
            inputMode="decimal"
            min="1"
            max="999999.99"
            step="0.01"
            type="number"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
        </span>
        <small id="donation-amount-help">
          Minimum $1. Enter any amount you like.
        </small>
      </label>

      <div className="donate-fields-two">
        <label className="donate-field" htmlFor="donor-name">
          <span>
            Name <small>optional</small>
          </span>
          <input
            id="donor-name"
            maxLength={100}
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="donate-field" htmlFor="donor-email">
          <span>
            Email <small>optional</small>
          </span>
          <input
            id="donor-email"
            maxLength={254}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
      </div>
      <label className="donate-field" htmlFor="donor-message">
        <span>
          Message <small>optional</small>
        </span>
        <textarea
          id="donor-message"
          maxLength={500}
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>

      <TurnstileWidget key={turnstile.widgetKey} {...turnstile.widgetProps} />
      {error && (
        <p className="donate-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary-button large donate-submit"
        disabled={busy || !validAmount || !turnstile.ready}
        type="submit"
      >
        {busy ? (
          <Loader2 className="donate-spin" aria-hidden="true" size={18} />
        ) : (
          <Coffee aria-hidden="true" size={18} />
        )}
        <span>
          {busy ? "Opening secure checkout…" : `Donate ${amountLabel}`}
        </span>
        {!busy && <ArrowRight aria-hidden="true" size={17} />}
      </button>
      <p className="donate-secure">
        Secure one-time payment handled by Stripe. Onshell never receives your
        card details.
      </p>
    </form>
  );
}
