"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, KeyRound, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { cx } from "@onshell/ui";
import { apiSend, errorText, formatDateTime, useAdminResource } from "./lib";

interface TurnstileSettings {
  siteKey: string;
  hasSecretKey: boolean;
  enabled: boolean;
  protectSignup: boolean;
  protectLogin: boolean;
  protectPasswordReset: boolean;
  protectContact: boolean;
  protectCheckout: boolean;
  protectNewsletter: boolean;
  updatedAt: string | null;
}

const FALLBACK: TurnstileSettings = {
  siteKey: "",
  hasSecretKey: false,
  enabled: false,
  protectSignup: true,
  protectLogin: true,
  protectPasswordReset: true,
  protectContact: true,
  protectCheckout: true,
  protectNewsletter: true,
  updatedAt: null
};

const FORMS: Array<{ key: keyof TurnstileSettings; label: string; hint: string }> = [
  { key: "protectSignup", label: "Sign up", hint: "Blocks automated account creation — the highest-value target." },
  { key: "protectLogin", label: "Sign in", hint: "Slows credential-stuffing on top of the per-account lockout." },
  { key: "protectPasswordReset", label: "Password reset", hint: "Stops reset-email flooding against known addresses." },
  { key: "protectContact", label: "Contact form", hint: "Keeps the admin inbox free of spam submissions." },
  { key: "protectCheckout", label: "Checkout", hint: "Prevents scripted checkout attempts against the billing provider." },
  { key: "protectNewsletter", label: "Newsletter signup", hint: "Keeps the marketing list clean." }
];

/**
 * Cloudflare Turnstile credentials and per-form toggles.
 *
 * The site key is public and served to browsers at runtime via
 * GET /public/site-config, so rotating it here takes effect without a rebuild.
 * The secret key is stored encrypted and never returned to this form.
 */
export function BotProtectionPanel() {
  const { data, loading, error, reload } = useAdminResource<TurnstileSettings>("/admin/turnstile", FALLBACK);

  const [form, setForm] = useState<TurnstileSettings | null>(null);
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (loading && !form) return <p className="admin-empty">Loading bot-protection settings…</p>;
  if (!form) return <p className="admin-inline-error">{error ?? "Could not load bot-protection settings."}</p>;

  function update<K extends keyof TurnstileSettings>(key: K, value: TurnstileSettings[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setFeedback(null);
  }

  const canEnable = Boolean(form.siteKey.trim()) && (form.hasSecretKey || secretKey.trim().length > 0);

  async function save() {
    setBusy(true);
    setFeedback(null);
    try {
      const saved = await apiSend<TurnstileSettings>("/admin/turnstile", "PATCH", {
        siteKey: form!.siteKey.trim(),
        // Only sent when the operator typed one, so saving other fields does not
        // clear the stored secret.
        ...(secretKey.trim() ? { secretKey: secretKey.trim() } : {}),
        enabled: form!.enabled,
        protectSignup: form!.protectSignup,
        protectLogin: form!.protectLogin,
        protectPasswordReset: form!.protectPasswordReset,
        protectContact: form!.protectContact,
        protectCheckout: form!.protectCheckout,
        protectNewsletter: form!.protectNewsletter
      });
      setForm(saved);
      setSecretKey("");
      setFeedback({ kind: "success", text: "Bot-protection settings saved." });
    } catch (caught) {
      setFeedback({ kind: "error", text: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-card">
      <div className="admin-card-head">
        <div>
          <h2>
            <ShieldCheck aria-hidden="true" size={17} />
            Bot protection
          </h2>
          <p>
            Cloudflare Turnstile on the public forms. Create a widget at{" "}
            <a href="https://dash.cloudflare.com/?to=/:account/turnstile" rel="noopener noreferrer" target="_blank">
              dash.cloudflare.com → Turnstile
            </a>{" "}
            and paste the key pair below. Add <code>onshell.cloud</code> as an allowed hostname.
          </p>
        </div>
        <button className="admin-icon-button" type="button" aria-label="Reload" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" size={15} />
        </button>
      </div>

      <label className="admin-toggle">
        <input
          type="checkbox"
          checked={form.enabled}
          disabled={!canEnable && !form.enabled}
          onChange={(event) => update("enabled", event.target.checked)}
        />
        <span>
          <strong>Enable bot protection</strong>
          <small>
            {canEnable
              ? "Verification fails closed: if Cloudflare cannot be reached, protected requests are refused rather than allowed through."
              : "Add both keys below before enabling."}
          </small>
        </span>
      </label>

      <div className="admin-grid-2">
        <label className="admin-field">
          <span>Site key</span>
          <input
            value={form.siteKey}
            onChange={(event) => update("siteKey", event.target.value)}
            placeholder="0x4AAAAAAA…"
            autoComplete="off"
          />
          <small>Public. Served to browsers at runtime — rotating it needs no rebuild.</small>
        </label>

        <label className="admin-field">
          <span>
            <KeyRound aria-hidden="true" size={13} /> Secret key
          </span>
          <input
            type="password"
            autoComplete="off"
            value={secretKey}
            onChange={(event) => setSecretKey(event.target.value)}
            placeholder={form.hasSecretKey ? "•••••••• (stored — type to replace)" : "0x4AAAAAAA…"}
          />
          <small>
            {form.hasSecretKey
              ? "Leave blank to keep the stored key. Encrypted at rest."
              : "Required before enabling. Encrypted at rest."}
          </small>
        </label>
      </div>

      <fieldset className="admin-fieldset">
        <legend>Protected forms</legend>
        <p className="admin-meta">
          Turn a form off if the challenge is causing friction there. Signup and password reset are the two worth keeping
          on.
        </p>
        <div className="admin-grid-2">
          {FORMS.map((entry) => (
            <label className="admin-toggle compact" key={entry.key}>
              <input
                type="checkbox"
                checked={Boolean(form[entry.key])}
                onChange={(event) => update(entry.key, event.target.checked as never)}
              />
              <span>
                <strong>{entry.label}</strong>
                <small>{entry.hint}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="admin-actions">
        <button className="admin-button primary" type="button" disabled={busy} onClick={() => void save()}>
          <Save aria-hidden="true" size={15} />
          {busy ? "Saving…" : "Save bot protection"}
        </button>
        {form.updatedAt && <span className="admin-meta">Last updated {formatDateTime(form.updatedAt)}</span>}
      </div>

      {feedback && (
        <p className={cx("admin-inline-feedback", feedback.kind === "error" && "is-error")} role="status">
          {feedback.kind === "error" ? (
            <AlertCircle aria-hidden="true" size={15} />
          ) : (
            <CheckCircle2 aria-hidden="true" size={15} />
          )}
          {feedback.text}
        </p>
      )}
    </div>
  );
}
