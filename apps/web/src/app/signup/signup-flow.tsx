"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import {
  Building2,
  Check,
  Circle,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  ShieldCheck,
  UserRound,
  UserPlus
} from "lucide-react";
import { passwordPolicy, validatePassword } from "@onshell/shared";
import { TurnstileWidget, useTurnstile } from "../../components/turnstile";
import { apiBaseUrl } from "../../lib/site";
import { OnshellMark } from "../brand";
import { ThemeToggle } from "../theme";
import "../auth.css";

const RESEND_SECONDS = 30;

type Mode = "signup" | "twofa";
type TwoFactorMethod = "totp" | "email";
type Tone = "info" | "error" | "success";

type PasswordRequirement = { label: string; met: boolean };

function passwordRequirements(password: string): PasswordRequirement[] {
  const reqs: PasswordRequirement[] = [
    { label: `At least ${passwordPolicy.minLength} characters`, met: password.length >= passwordPolicy.minLength }
  ];
  if (passwordPolicy.requireLowercase) reqs.push({ label: "One lowercase letter", met: /[a-z]/.test(password) });
  if (passwordPolicy.requireUppercase) reqs.push({ label: "One uppercase letter", met: /[A-Z]/.test(password) });
  if (passwordPolicy.requireDigit) reqs.push({ label: "One number", met: /[0-9]/.test(password) });
  if (passwordPolicy.requireSymbol) reqs.push({ label: "One symbol (!@#?…)", met: /[^a-zA-Z0-9]/.test(password) });
  return reqs;
}

function PasswordStrength({ password, describedById }: { password: string; describedById: string }) {
  const reqs = passwordRequirements(password);
  const met = reqs.filter((requirement) => requirement.met).length;
  const ratio = reqs.length ? met / reqs.length : 0;
  const level = ratio >= 1 ? "strong" : ratio >= 0.5 ? "medium" : "weak";
  const width = password ? Math.max(ratio * 100, 8) : 0;

  return (
    <div className="pw-meter" id={describedById}>
      <div className="pw-track" aria-hidden="true">
        <div className={`pw-fill ${password ? level : ""}`} style={{ width: `${width}%` }} />
      </div>
      <ul className="pw-reqs">
        {reqs.map((requirement) => (
          <li key={requirement.label} className={`pw-req ${requirement.met ? "met" : "unmet"}`}>
            <span className="pw-req-icon" aria-hidden="true">
              {requirement.met ? <Check size={14} /> : <Circle size={14} />}
            </span>
            <span>{requirement.label}</span>
            <span className="sr-only">{requirement.met ? "requirement met" : "requirement not met"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function mapErrorCode(code?: string): string | undefined {
  switch (code) {
    case "email_already_registered":
      return "An account with this email already exists. Try logging in instead.";
    case "password_policy_violation":
      return "Please choose a stronger password.";
    case "invalid_two_factor_code":
      return "That code is invalid. Please try again.";
    case "too_many_attempts":
      return "Too many attempts. Please start over.";
    case "two_factor_challenge_not_found":
      return "Your verification session expired. Please sign up again.";
    case "resend_rate_limited":
      return "Please wait before requesting another code.";
    case "google_oauth_not_configured":
      return "Google sign-up isn't configured yet.";
    case "captcha_required":
      return "Please complete the bot-protection challenge before continuing.";
    case "captcha_failed":
      return "The bot-protection challenge couldn't be verified. Please try it again.";
    case "captcha_unavailable":
      return "Bot protection is temporarily unavailable. Please try again shortly.";
    case "rate_limited":
      return "Too many attempts from this network. Please wait a moment and try again.";
    default:
      return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorText(payload: any, fallback: string): string {
  if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors.join(" ");
  }
  return payload?.message ?? mapErrorCode(payload?.error) ?? fallback;
}

export function SignupFlow() {
  const turnstile = useTurnstile("signup");

  const [mode, setMode] = useState<Mode>("signup");
  /** Referral attribution from a shared /signup?ref=CODE link. */
  const [referralCode, setReferralCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [tone, setTone] = useState<Tone>("info");
  const [message, setMessage] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [challengeId, setChallengeId] = useState("");
  const [method, setMethod] = useState<TwoFactorMethod>("totp");
  const [code, setCode] = useState("");
  const [resendIn, setResendIn] = useState(0);

  const passwordValid = validatePassword(password).valid;
  const confirmMismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const canSubmit =
    !busy &&
    name.trim().length >= 2 &&
    email.length > 0 &&
    organizationName.trim().length >= 2 &&
    passwordValid &&
    confirmPassword === password &&
    turnstile.ready;

  function setStatus(nextTone: Tone, nextMessage: string) {
    setTone(nextTone);
    setMessage(nextMessage);
  }

  // 30s (or server-provided) resend cooldown countdown for email 2FA.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  // Pick up ?ref=CODE so referral credit survives the signup, without showing
  // the code as an editable field.
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) setReferralCode(ref.trim().toUpperCase().slice(0, 16));
  }, []);

  async function submitRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordValid) {
      setStatus("error", "Please choose a password that meets every requirement.");
      return;
    }
    if (confirmPassword !== password) {
      setStatus("error", "Those passwords don't match.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/register`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          organizationName,
          password,
          ...(referralCode ? { referralCode } : {}),
          ...(turnstile.token ? { turnstileToken: turnstile.token } : {})
        })
      });
      const payload = await response.json().catch(() => ({}));

      // Defensive: register does not normally require 2FA, but handle it like login.
      if (response.status === 202 && payload.challengeId) {
        const resolvedMethod: TwoFactorMethod = payload.method === "email" ? "email" : "totp";
        setChallengeId(payload.challengeId);
        setMethod(resolvedMethod);
        setCode("");
        setMode("twofa");
        setStatus(
          "info",
          payload.message ??
            (resolvedMethod === "email"
              ? "We emailed you a 6-digit code."
              : "Enter the 6-digit code from your authenticator app.")
        );
        if (resolvedMethod === "email") setResendIn(RESEND_SECONDS);
        return;
      }

      if (!response.ok) {
        // A challenge this page never displayed means the site config it loaded
        // is stale or failed — refetch it so the widget appears on the retry.
        if (turnstile.recoverFromServerRejection(payload.error)) {
          setStatus(
            "error",
            "Bot protection needs to load before you can sign up. Give it a moment and try again."
          );
          return;
        }
        // Turnstile tokens are single-use, so a retry needs a fresh challenge.
        turnstile.reset();
        setStatus("error", errorText(payload, "We couldn't create your account."));
        return;
      }

      setStatus("success", "Account created. Redirecting to your console…");
      window.location.href = "/console";
    } catch {
      turnstile.reset();
      setStatus("error", "Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitTwoFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/2fa/complete`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, code })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (payload.error === "too_many_attempts" || payload.error === "two_factor_challenge_not_found") {
          setMode("signup");
          setCode("");
        }
        setStatus("error", errorText(payload, "That code didn't work."));
        return;
      }

      setStatus("success", "Verified. Redirecting to your console…");
      window.location.href = "/console";
    } catch {
      setStatus("error", "Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (busy || resendIn > 0) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/2fa/challenge/resend`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId })
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 429) {
        const wait = Number(payload.retryAfterSeconds) > 0 ? Number(payload.retryAfterSeconds) : RESEND_SECONDS;
        setResendIn(wait);
        setStatus("info", `Please wait ${wait}s before requesting another code.`);
        return;
      }

      if (!response.ok) {
        setStatus("error", errorText(payload, "We couldn't resend the code."));
        return;
      }

      setResendIn(RESEND_SECONDS);
      setStatus("success", "A new code is on its way.");
    } catch {
      setStatus("error", "Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function startGoogle() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/google/start?returnTo=/console`, {
        credentials: "include"
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.authUrl) {
        setStatus("error", errorText(payload, "Google sign-up isn't available right now."));
        setBusy(false);
        return;
      }

      window.location.href = payload.authUrl;
    } catch {
      setStatus("error", "Network error. Please check your connection and try again.");
      setBusy(false);
    }
  }

  const headings: Record<Mode, { title: string; subtitle: string }> = {
    signup: {
      title: "Create your free workspace",
      subtitle: "Browser-based SSH, SFTP, and RDP access — free for one person, no card needed."
    },
    twofa: {
      title: "Two-factor verification",
      subtitle:
        method === "email"
          ? "We emailed you a 6-digit code. Enter it to continue."
          : "Enter the 6-digit code from your authenticator app."
    }
  };

  return (
    <main className="auth-shell">
      <div className="auth-topbar">
        <Link className="auth-brand" href="/">
          <OnshellMark size={34} />
          <span className="auth-brand-text">
            <span className="brand-name">Onshell.cloud</span>
            <span className="brand-domain">Secure remote access</span>
          </span>
        </Link>
        <ThemeToggle />
      </div>

      <div className="auth-main">
        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-heading">
            <h1 id="auth-title">{headings[mode].title}</h1>
            <p>{headings[mode].subtitle}</p>
          </div>

          {message && (
            <p className={`auth-message ${tone}`} role="status" aria-live="polite">
              {message}
            </p>
          )}

          {mode === "signup" && (
            <>
              <form className="auth-form" onSubmit={submitRegister} noValidate>
                <div className="auth-field">
                  <label htmlFor="signup-name">Full name</label>
                  <div className="auth-input-wrap">
                    <UserRound size={17} aria-hidden="true" />
                    <input
                      id="signup-name"
                      className="auth-input has-icon"
                      type="text"
                      autoComplete="name"
                      placeholder="Ada Lovelace"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="auth-field">
                  <label htmlFor="signup-email">Work email</label>
                  <div className="auth-input-wrap">
                    <Mail size={17} aria-hidden="true" />
                    <input
                      id="signup-email"
                      className="auth-input has-icon"
                      type="email"
                      autoComplete="email"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="auth-field">
                  <label htmlFor="signup-org">Organization name</label>
                  <div className="auth-input-wrap">
                    <Building2 size={17} aria-hidden="true" />
                    <input
                      id="signup-org"
                      className="auth-input has-icon"
                      type="text"
                      autoComplete="organization"
                      placeholder="Acme Inc."
                      value={organizationName}
                      onChange={(event) => setOrganizationName(event.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="auth-field">
                  <label htmlFor="signup-password">Password</label>
                  <div className="auth-input-wrap">
                    <KeyRound size={17} aria-hidden="true" />
                    <input
                      id="signup-password"
                      className="auth-input has-icon has-reveal"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      aria-describedby="signup-pw-reqs"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                    />
                    <button
                      type="button"
                      className="auth-reveal"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((visible) => !visible)}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <PasswordStrength password={password} describedById="signup-pw-reqs" />
                </div>

                <div className="auth-field">
                  <label htmlFor="signup-confirm">Confirm password</label>
                  <div className="auth-input-wrap">
                    <KeyRound size={17} aria-hidden="true" />
                    <input
                      id="signup-confirm"
                      className="auth-input has-icon"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      aria-describedby={confirmMismatch ? "signup-confirm-hint" : undefined}
                      aria-invalid={confirmMismatch}
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      required
                    />
                  </div>
                  {confirmMismatch && (
                    <span id="signup-confirm-hint" className="auth-hint error">
                      Those passwords don&apos;t match.
                    </span>
                  )}
                </div>

                <TurnstileWidget key={turnstile.widgetKey} {...turnstile.widgetProps} />

                <button className="primary-button large full-width" type="submit" disabled={!canSubmit}>
                  {busy ? <span className="auth-spinner" aria-hidden="true" /> : <UserPlus size={17} />}
                  {busy ? "Creating account…" : "Create free account"}
                </button>

                <p className="auth-fineprint">
                  Free forever for one person — no credit card required. Upgrade to Team or Business whenever your
                  workspace grows.
                </p>
              </form>

              <div className="auth-divider">
                <span className="auth-rule" />
                <span className="auth-divider-text">or</span>
                <span className="auth-rule" />
              </div>

              <button type="button" className="google-button" onClick={startGoogle} disabled={busy}>
                <span className="google-g" aria-hidden="true">
                  G
                </span>
                Sign up with Google
              </button>

              <p className="auth-alt">
                Already have an account? <Link href="/login">Log in</Link>
              </p>
            </>
          )}

          {mode === "twofa" && (
            <form className="auth-form" onSubmit={submitTwoFactor} noValidate>
              <div className="auth-field">
                <label htmlFor="twofa-code">6-digit code</label>
                <div className="auth-input-wrap">
                  <ShieldCheck size={17} aria-hidden="true" />
                  <input
                    id="twofa-code"
                    className="auth-input has-icon auth-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={8}
                    placeholder="123456"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                    required
                  />
                </div>
              </div>

              <button className="primary-button large full-width" type="submit" disabled={busy || code.length < 6}>
                {busy ? <span className="auth-spinner" aria-hidden="true" /> : <ShieldCheck size={17} />}
                {busy ? "Verifying…" : "Verify and continue"}
              </button>

              {method === "email" && (
                <div className="twofa-resend">
                  <span>Didn&apos;t get the email?</span>
                  <button type="button" className="text-link" onClick={resendCode} disabled={busy || resendIn > 0}>
                    {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                  </button>
                </div>
              )}

              <button
                type="button"
                className="text-link auth-center"
                onClick={() => {
                  setMode("signup");
                  setCode("");
                  setMessage("");
                }}
              >
                Back to sign up
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
