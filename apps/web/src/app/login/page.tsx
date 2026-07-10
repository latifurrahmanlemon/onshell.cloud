"use client";

import { FormEvent, useMemo, useState } from "react";
import { Cloud, KeyRound, LockKeyhole, Mail, ShieldCheck } from "lucide-react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type LoginState = "idle" | "loading" | "two-factor" | "success" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [state, setState] = useState<LoginState>("idle");
  const [message, setMessage] = useState("");

  const queryChallengeId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("challengeId") ?? "";
  }, []);

  async function submitPasswordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("loading");
    setMessage("");

    const response = await fetch(`${apiBaseUrl}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    const payload = await response.json();
    if (response.status === 202 && payload.challengeId) {
      setChallengeId(payload.challengeId);
      setState("two-factor");
      setMessage("Enter the 6-digit code from Google Authenticator.");
      return;
    }

    if (!response.ok) {
      setState("error");
      setMessage(payload.message ?? payload.error ?? "Login failed.");
      return;
    }

    setState("success");
    setMessage("Login successful. Redirecting to console...");
    window.location.href = "/console";
  }

  async function submitTwoFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("loading");
    const activeChallengeId = challengeId || queryChallengeId;
    const response = await fetch(`${apiBaseUrl}/auth/2fa/complete`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: activeChallengeId, totpCode })
    });

    const payload = await response.json();
    if (!response.ok) {
      setState("two-factor");
      setMessage(payload.message ?? payload.error ?? "Invalid authenticator code.");
      return;
    }

    setState("success");
    setMessage("Authenticator verified. Redirecting to console...");
    window.location.href = "/console";
  }

  async function startGoogleLogin() {
    setState("loading");
    setMessage("");
    const response = await fetch(`${apiBaseUrl}/auth/google/start?returnTo=/console`);
    const payload = await response.json();

    if (!response.ok) {
      setState("error");
      setMessage(payload.message ?? payload.error ?? "Google login is not configured yet.");
      return;
    }

    window.location.href = payload.authUrl;
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-row">
          <div className="brand-mark">
            <Cloud size={18} />
          </div>
          <div>
            <p className="brand-name">Onshell.cloud</p>
            <p className="brand-domain">Secure remote access login</p>
          </div>
        </div>

        <div className="login-heading">
          <h1>Sign in to your workspace</h1>
          <p>Email/password, Google login, and Google Authenticator verification are supported.</p>
        </div>

        {(state === "two-factor" || queryChallengeId) && (
          <form className="auth-form" onSubmit={submitTwoFactor}>
            <label>
              <span>Authenticator code</span>
              <div className="input-with-icon">
                <ShieldCheck size={17} />
                <input
                  inputMode="numeric"
                  maxLength={8}
                  onChange={(event) => setTotpCode(event.target.value)}
                  placeholder="123456"
                  value={totpCode}
                />
              </div>
            </label>
            <button className="primary-button large full-width" disabled={state === "loading"} type="submit">
              <LockKeyhole size={17} />
              Verify 2FA
            </button>
          </form>
        )}

        {state !== "two-factor" && !queryChallengeId && (
          <>
            <form className="auth-form" onSubmit={submitPasswordLogin}>
              <label>
                <span>Email</span>
                <div className="input-with-icon">
                  <Mail size={17} />
                  <input onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
                </div>
              </label>
              <label>
                <span>Password</span>
                <div className="input-with-icon">
                  <KeyRound size={17} />
                  <input onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
                </div>
              </label>
              <button className="primary-button large full-width" disabled={state === "loading"} type="submit">
                Sign In
              </button>
            </form>

            <div className="auth-divider">
              <span />
              <strong>or</strong>
              <span />
            </div>

            <button className="google-button" disabled={state === "loading"} onClick={startGoogleLogin} type="button">
              <span>G</span>
              Continue with Google
            </button>
          </>
        )}

        {message && <p className={`auth-message ${state}`}>{message}</p>}
      </section>
    </main>
  );
}
