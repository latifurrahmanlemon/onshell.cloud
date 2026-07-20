"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Circle, Eye, EyeOff, KeyRound, LogIn, Mail, ShieldCheck } from "lucide-react";
import { passwordPolicy, validatePassword } from "@onshell/shared";
import { OnshellMark } from "../brand";
import { ThemeToggle } from "../theme";
import "../auth.css";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const RESEND_SECONDS = 30;

type Mode = "login" | "twofa" | "forgot-request" | "forgot-reset";
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
    case "invalid_credentials":
      return "That email or password is incorrect.";
    case "invalid_two_factor_code":
      return "That code is invalid. Please try again.";
    case "too_many_attempts":
      return "Too many attempts. Please sign in again.";
    case "two_factor_challenge_not_found":
      return "Your verification session expired. Please sign in again.";
    case "invalid_reset_code":
      return "That reset code is invalid or has expired.";
    case "password_policy_violation":
      return "Please choose a stronger password.";
    case "google_oauth_not_configured":
      return "Google sign-in isn't configured yet.";
    case "resend_rate_limited":
      return "Please wait before requesting another code.";
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

function mapGoogleRedirectError(code: string): string {
  switch (code) {
    case "google-not-configured":
      return "Google sign-in isn't configured yet.";
    case "invalid-google-state":
      return "Your Google sign-in session expired. Please try again.";
    case "google-callback-failed":
      return "Google sign-in failed. Please try again.";
    default:
      return "Something went wrong with Google sign-in. Please try again.";
  }
}

export default function LoginPage() {
  const reduceMotion = useReducedMotion();

  const [mode, setMode] = useState<Mode>("login");
  const [busy, setBusy] = useState(false);
  const [tone, setTone] = useState<Tone>("info");
  const [message, setMessage] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [challengeId, setChallengeId] = useState("");
  const [method, setMethod] = useState<TwoFactorMethod>("totp");
  const [code, setCode] = useState("");
  const [resendIn, setResendIn] = useState(0);

  const [resetOtp, setResetOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);

  const resetPasswordValid = validatePassword(newPassword).valid;

  function setStatus(nextTone: Tone, nextMessage: string) {
    setTone(nextTone);
    setMessage(nextMessage);
  }

  // Resume a 2FA challenge (e.g. after the Google callback redirect), or surface
  // a Google redirect error. Runs once on mount to avoid a hydration mismatch.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlChallengeId = params.get("challengeId");
    const urlMethod = params.get("method");
    const urlError = params.get("error");

    if (urlChallengeId) {
      const resolvedMethod: TwoFactorMethod = urlMethod === "email" ? "email" : "totp";
      setChallengeId(urlChallengeId);
      setMethod(resolvedMethod);
      setMode("twofa");
      if (resolvedMethod === "email") {
        setResendIn(RESEND_SECONDS);
        setStatus("info", "We emailed you a 6-digit code. Enter it below.");
      } else {
        setStatus("info", "Enter the 6-digit code from your authenticator app.");
      }
    } else if (urlError) {
      setStatus("error", mapGoogleRedirectError(urlError));
    }
  }, []);

  // 30s (or server-provided) resend cooldown countdown.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const payload = await response.json().catch(() => ({}));

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
        setStatus("error", errorText(payload, "We couldn't sign you in."));
        return;
      }

      setStatus("success", "Signed in. Redirecting to your console…");
      window.location.href = "/console";
    } catch {
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
          setMode("login");
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
        setStatus("error", errorText(payload, "Google sign-in isn't available right now."));
        setBusy(false);
        return;
      }

      window.location.href = payload.authUrl;
    } catch {
      setStatus("error", "Network error. Please check your connection and try again.");
      setBusy(false);
    }
  }

  async function submitForgotRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await fetch(`${apiBaseUrl}/auth/password/forgot`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email })
      });
      // The endpoint always returns a generic response, so advance regardless.
      setResetOtp("");
      setNewPassword("");
      setMode("forgot-reset");
      setStatus(
        "info",
        "If that email is registered, we've sent a 6-digit reset code. Enter it below with your new password."
      );
    } catch {
      setStatus("error", "Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitForgotReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetPasswordValid) {
      setStatus("error", "Please choose a password that meets every requirement.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/password/reset`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, otp: resetOtp, newPassword })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setStatus("error", errorText(payload, "We couldn't reset your password."));
        return;
      }

      setPassword("");
      setResetOtp("");
      setNewPassword("");
      setMode("login");
      setStatus("success", "Password updated. Sign in with your new password.");
    } catch {
      setStatus("error", "Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const cardMotion = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 14 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.35, ease: "easeOut" as const }
      };

  const headings: Record<Mode, { title: string; subtitle: string }> = {
    login: {
      title: "Sign in to Onshell",
      subtitle: "Access your browser-based SSH, SFTP, and RDP workspace."
    },
    twofa: {
      title: "Two-factor verification",
      subtitle:
        method === "email"
          ? "We emailed you a 6-digit code. Enter it to continue."
          : "Enter the 6-digit code from your authenticator app."
    },
    "forgot-request": {
      title: "Reset your password",
      subtitle: "Enter your work email and we'll send a 6-digit reset code."
    },
    "forgot-reset": {
      title: "Choose a new password",
      subtitle: "Enter the code we emailed you, then set a new password."
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
        <motion.section className="auth-card" aria-labelledby="auth-title" {...cardMotion}>
          <div className="auth-heading">
            <h1 id="auth-title">{headings[mode].title}</h1>
            <p>{headings[mode].subtitle}</p>
          </div>

          {message && (
            <p className={`auth-message ${tone}`} role="status" aria-live="polite">
              {message}
            </p>
          )}

          {mode === "login" && (
            <>
              <form className="auth-form" onSubmit={submitLogin} noValidate>
                <div className="auth-field">
                  <label htmlFor="login-email">Work email</label>
                  <div className="auth-input-wrap">
                    <Mail size={17} aria-hidden="true" />
                    <input
                      id="login-email"
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
                  <label htmlFor="login-password">Password</label>
                  <div className="auth-input-wrap">
                    <KeyRound size={17} aria-hidden="true" />
                    <input
                      id="login-password"
                      className="auth-input has-icon has-reveal"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
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
                  <button
                    type="button"
                    className="text-link auth-forgot"
                    onClick={() => {
                      setMode("forgot-request");
                      setMessage("");
                    }}
                  >
                    Forgot password?
                  </button>
                </div>

                <button className="primary-button large full-width" type="submit" disabled={busy || !email || !password}>
                  {busy ? <span className="auth-spinner" aria-hidden="true" /> : <LogIn size={17} />}
                  {busy ? "Signing in…" : "Sign in"}
                </button>
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
                Continue with Google
              </button>

              <p className="auth-alt">
                New here? <Link href="/signup">Create an account</Link>
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
                  setMode("login");
                  setCode("");
                  setMessage("");
                }}
              >
                Back to sign in
              </button>
            </form>
          )}

          {mode === "forgot-request" && (
            <form className="auth-form" onSubmit={submitForgotRequest} noValidate>
              <div className="auth-field">
                <label htmlFor="forgot-email">Work email</label>
                <div className="auth-input-wrap">
                  <Mail size={17} aria-hidden="true" />
                  <input
                    id="forgot-email"
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

              <button className="primary-button large full-width" type="submit" disabled={busy || !email}>
                {busy ? <span className="auth-spinner" aria-hidden="true" /> : <Mail size={17} />}
                {busy ? "Sending…" : "Send reset code"}
              </button>

              <button
                type="button"
                className="text-link auth-center"
                onClick={() => {
                  setMode("login");
                  setMessage("");
                }}
              >
                Back to sign in
              </button>
            </form>
          )}

          {mode === "forgot-reset" && (
            <form className="auth-form" onSubmit={submitForgotReset} noValidate>
              <div className="auth-field">
                <label htmlFor="reset-otp">Reset code</label>
                <div className="auth-input-wrap">
                  <ShieldCheck size={17} aria-hidden="true" />
                  <input
                    id="reset-otp"
                    className="auth-input has-icon auth-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="6-digit code"
                    value={resetOtp}
                    onChange={(event) => setResetOtp(event.target.value.replace(/\D/g, ""))}
                    required
                  />
                </div>
              </div>

              <div className="auth-field">
                <label htmlFor="reset-password">New password</label>
                <div className="auth-input-wrap">
                  <KeyRound size={17} aria-hidden="true" />
                  <input
                    id="reset-password"
                    className="auth-input has-icon has-reveal"
                    type={showNewPassword ? "text" : "password"}
                    autoComplete="new-password"
                    aria-describedby="reset-pw-reqs"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="auth-reveal"
                    aria-label={showNewPassword ? "Hide password" : "Show password"}
                    aria-pressed={showNewPassword}
                    onClick={() => setShowNewPassword((visible) => !visible)}
                  >
                    {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <PasswordStrength password={newPassword} describedById="reset-pw-reqs" />
              </div>

              <button
                className="primary-button large full-width"
                type="submit"
                disabled={busy || resetOtp.length !== 6 || !resetPasswordValid}
              >
                {busy ? <span className="auth-spinner" aria-hidden="true" /> : <KeyRound size={17} />}
                {busy ? "Updating…" : "Reset password"}
              </button>

              <button
                type="button"
                className="text-link auth-center"
                onClick={() => {
                  setMode("login");
                  setMessage("");
                }}
              >
                Back to sign in
              </button>
            </form>
          )}
        </motion.section>
      </div>
    </main>
  );
}
