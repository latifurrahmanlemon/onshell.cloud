"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, LogIn, RefreshCw, ServerCog, ShieldCheck } from "lucide-react";
import { ThemeToggle } from "../theme";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type GateStatus = "checking" | "login" | "forbidden" | "authorized";
type LoginPhase = "credentials" | "twofa";

interface MePayload {
  user?: { name?: string; email?: string; isPlatformAdmin?: boolean };
}

/**
 * Gates the admin panel: /admin renders a sign-in screen and only mounts the
 * panel (its children) once an authenticated platform admin is confirmed.
 */
export default function AdminGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>("checking");
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<LoginPhase>("credentials");
  const [challengeId, setChallengeId] = useState("");
  const [method, setMethod] = useState<"totp" | "email">("totp");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  const checkAccess = useCallback(async (): Promise<GateStatus> => {
    try {
      const response = await fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" });
      if (!response.ok) return "login";
      const payload = (await response.json()) as MePayload;
      const user = payload.user;
      if (user?.isPlatformAdmin) {
        return "authorized";
      }
      setSignedInAs(user?.email ?? null);
      return "forbidden";
    } catch {
      return "login";
    }
  }, []);

  useEffect(() => {
    let active = true;
    checkAccess().then((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
    };
  }, [checkAccess]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 202 && payload.challengeId) {
        setChallengeId(payload.challengeId);
        setMethod(payload.method === "email" ? "email" : "totp");
        setMessage(
          payload.message ??
            (payload.method === "email"
              ? "We emailed you a 6-digit verification code."
              : "Enter the code from your authenticator app.")
        );
        if (payload.method === "email") setResendIn(30);
        setPhase("twofa");
        return;
      }

      if (!response.ok) {
        setError(payload.error ?? "Sign in failed.");
        return;
      }

      await finishLogin();
    } catch {
      setError("The API is not reachable. Start it with `yarn dev`.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitTwoFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/2fa/complete`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, code })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error ?? "That code was not accepted.");
        return;
      }
      await finishLogin();
    } catch {
      setError("The API is not reachable.");
    } finally {
      setSubmitting(false);
    }
  }

  async function resendCode() {
    if (resendIn > 0) return;
    try {
      const response = await fetch(`${apiBaseUrl}/auth/2fa/challenge/resend`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) {
        setResendIn(Number(payload.retryAfterSeconds) || 30);
        return;
      }
      setResendIn(30);
      setMessage("A new code is on its way to your inbox.");
    } catch {
      setError("Could not resend the code.");
    }
  }

  async function finishLogin() {
    const next = await checkAccess();
    setStatus(next);
    if (next === "authorized" || next === "forbidden") {
      setError("");
      return;
    }

    // The credentials were accepted — /auth/login returned a token — but the
    // follow-up /auth/me came back unauthenticated. That is never a bad password;
    // it means the session cookie was not stored, so say so instead of blaming
    // the credentials and sending the operator to reset a working password.
    setError(
      "Your password was accepted, but the browser did not keep the session cookie. " +
        "This usually means the site is being served over http:// while COOKIE_SECURE is on, " +
        "or the host you are visiting is outside COOKIE_DOMAIN. Check both, then try again."
    );
  }

  async function switchAccount() {
    try {
      await fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" });
    } finally {
      setSignedInAs(null);
      setPassword("");
      setCode("");
      setPhase("credentials");
      setError("");
      setStatus("login");
    }
  }

  if (status === "authorized") {
    return <>{children}</>;
  }

  return (
    <main className="admin-gate">
      <div className="admin-gate-toggle">
        <ThemeToggle />
      </div>

      <div className="admin-gate-card panel">
        <div className="admin-gate-head">
          <div className="admin-gate-badge">
            {status === "forbidden" ? <ShieldCheck size={22} /> : <ServerCog size={22} />}
          </div>
          <h1>Admin access</h1>
          <p>
            {status === "checking"
              ? "Verifying your session…"
              : status === "forbidden"
                ? "This account does not have platform-admin rights."
                : "Sign in with a platform-admin account to open the panel."}
          </p>
        </div>

        {status === "checking" && (
          <div className="admin-gate-body">
            <div className="admin-gate-loading">
              <Loader2 className="adm-spin" size={18} />
              Checking access…
            </div>
          </div>
        )}

        {status === "forbidden" && (
          <div className="admin-gate-body">
            <p className="admin-gate-note">
              {signedInAs ? (
                <>
                  You are signed in as <strong>{signedInAs}</strong>, which cannot manage the platform.
                </>
              ) : (
                "Your account cannot manage the platform."
              )}
            </p>
            <button className="primary-button full-width" onClick={switchAccount} type="button">
              <LogIn size={16} />
              Use a different account
            </button>
            <a className="secondary-button full-width" href="/console">
              Go to your console
            </a>
          </div>
        )}

        {status === "login" && phase === "credentials" && (
          <form className="admin-gate-body" onSubmit={submitCredentials}>
            <label htmlFor="admin-email">
              Email
              <input
                autoComplete="email"
                id="admin-email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@onshell.cloud"
                required
                type="email"
                value={email}
              />
            </label>
            <label htmlFor="admin-password">
              Password
              <input
                autoComplete="current-password"
                id="admin-password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••"
                required
                type="password"
                value={password}
              />
            </label>
            {error && (
              <p aria-live="polite" className="admin-gate-error">
                <AlertTriangle size={14} />
                {error}
              </p>
            )}
            <button className="primary-button full-width" disabled={submitting} type="submit">
              {submitting ? <Loader2 className="adm-spin" size={16} /> : <LogIn size={16} />}
              Sign in
            </button>
          </form>
        )}

        {status === "login" && phase === "twofa" && (
          <form className="admin-gate-body" onSubmit={submitTwoFactor}>
            <p aria-live="polite" className="admin-gate-note">
              <CheckCircle2 size={14} />
              {message}
            </p>
            <label htmlFor="admin-2fa">
              {method === "email" ? "Emailed code" : "Authenticator code"}
              <input
                autoComplete="one-time-code"
                id="admin-2fa"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                required
                value={code}
              />
            </label>
            {method === "email" && (
              <button className="admin-gate-resend" disabled={resendIn > 0} onClick={resendCode} type="button">
                <RefreshCw size={13} />
                {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
              </button>
            )}
            {error && (
              <p aria-live="polite" className="admin-gate-error">
                <AlertTriangle size={14} />
                {error}
              </p>
            )}
            <button className="primary-button full-width" disabled={submitting || code.length !== 6} type="submit">
              {submitting ? <Loader2 className="adm-spin" size={16} /> : <ShieldCheck size={16} />}
              Verify
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
