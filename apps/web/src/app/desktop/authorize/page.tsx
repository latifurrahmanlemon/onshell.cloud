"use client";

/**
 * Approving a sign-in for the Onshell desktop app.
 *
 * The app cannot run Google's redirect, cannot render a bot-protection widget,
 * and knows nothing about the session this browser is probably already holding.
 * So it asks the server for a pending sign-in and sends the person here, and
 * this page is where a real, signed-in human decides whether that machine gets a
 * session for their account.
 *
 * Two rules the implementation has to keep, because they are the whole defence:
 *
 *  1. **Approval is never automatic.** Nothing is granted on load, on redirect,
 *     or on a prefetch. It takes a click on a button the person read the label
 *     of. Anything else and a link in an email is a session.
 *  2. **The code comes from the app window, not from the link.** The URL
 *     carries an opaque request id and nothing else; the code is typed. That is
 *     what makes this safe against the attack this shape of flow invites — an
 *     attacker starting a request on their own machine and phishing the link at
 *     someone who happens to be signed in. They can send the link. They cannot
 *     make a stranger's app window display their code.
 *
 * The machine name below is whatever the client said it was, so it is presented
 * as a claim rather than a fact: an unrecognised name is the signal to refuse.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Laptop, ShieldCheck, X } from "lucide-react";
import { apiBaseUrl } from "../../../lib/site";
import { OnshellMark } from "../../brand";
import { ThemeToggle } from "../../theme";
import "../../auth.css";
import "./authorize.css";

type Phase =
  | "checking"
  | "signed-out"
  | "ready"
  | "approved"
  | "denied"
  /** No request id in the URL at all — somebody navigated here by hand. */
  | "missing"
  /** Expired, already answered, or never existed. Deliberately one state. */
  | "gone";

type Tone = "info" | "error" | "success";

interface RequestPreview {
  status: "pending" | "approved" | "denied";
  machineName: string;
  platform: string;
  appVersion?: string;
  requestedAt: string;
  expiresAt: string;
}

const platformNames: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux"
};

function platformLabel(platform: string) {
  return platformNames[platform] ?? platform;
}

/**
 * Reads the request id out of the address, defensively.
 *
 * The Google callback appends `?login=google` to whatever return path it was
 * given, so a visitor who signed in with Google on the way here arrives at
 * `?request=dar_abc?login=google` — two query strings, and `get("request")`
 * hands back both. Ids are base64url, so trimming at the first character that
 * cannot be part of one recovers the real value instead of sending a mangled id
 * to the server and reporting "expired".
 */
function readRequestId(search: string) {
  const raw = new URLSearchParams(search).get("request") ?? "";
  return /^[A-Za-z0-9_-]+/.exec(raw)?.[0] ?? "";
}

function describe(payload: { error?: string; message?: string } | null, fallback: string) {
  switch (payload?.error) {
    case "invalid_user_code":
      return "That code does not match the one in the app window. Check it and try again.";
    case "auth_request_not_found":
      return "That request has expired. Start a new one from the app.";
    case "auth_request_already_resolved":
      return "That request has already been answered.";
    case "rate_limited":
      return "Too many attempts from this network. Wait a moment and try again.";
    case "unauthorized":
      return "Your session expired. Sign in again and reopen this page.";
    default:
      return payload?.message ?? fallback;
  }
}

export default function DesktopAuthorizePage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [requestId, setRequestId] = useState("");
  const [preview, setPreview] = useState<RequestPreview>();
  const [userCode, setUserCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [tone, setTone] = useState<Tone>("info");
  const [message, setMessage] = useState("");

  function setStatus(nextTone: Tone, nextMessage: string) {
    setTone(nextTone);
    setMessage(nextMessage);
  }

  /**
   * Same shape the admin gate uses: an expired access token is not a signed-out
   * user, because the refresh cookie outlives it by weeks. Trade it in before
   * concluding anybody needs to sign in again.
   */
  const isSignedIn = useCallback(async () => {
    try {
      let response = await fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" });
      if (response.status === 401) {
        const refreshed = await fetch(`${apiBaseUrl}/auth/refresh`, {
          method: "POST",
          credentials: "include"
        });
        if (!refreshed.ok) return false;
        response = await fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" });
      }
      return response.ok;
    } catch {
      return false;
    }
  }, []);

  // Read from window.location rather than useSearchParams: the same reason the
  // login page does, which is that the value is only needed after mount and a
  // search-param hook drags a Suspense boundary in for no benefit.
  useEffect(() => {
    const id = readRequestId(window.location.search);
    if (!id) {
      setPhase("missing");
      return;
    }
    setRequestId(id);

    let active = true;
    void (async () => {
      if (!(await isSignedIn())) {
        if (active) setPhase("signed-out");
        return;
      }

      try {
        const response = await fetch(
          `${apiBaseUrl}/desktop/auth/requests/${encodeURIComponent(id)}/preview`,
          { credentials: "include" }
        );
        if (!active) return;
        if (!response.ok) {
          setPhase("gone");
          return;
        }
        const payload = (await response.json()) as { request?: RequestPreview };
        if (!active) return;
        if (!payload.request || payload.request.status !== "pending") {
          setPhase("gone");
          return;
        }
        setPreview(payload.request);
        setPhase("ready");
      } catch {
        if (active) {
          setPhase("gone");
          setStatus("error", "The API is not reachable right now.");
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [isSignedIn]);

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `${apiBaseUrl}/desktop/auth/requests/${encodeURIComponent(requestId)}/approve`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userCode })
        }
      );
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 404 || response.status === 409) {
          setPhase("gone");
          setStatus("error", describe(payload, "That request is no longer waiting."));
          return;
        }
        setStatus("error", describe(payload, "That approval could not be completed."));
        return;
      }

      setPhase("approved");
    } catch {
      setStatus("error", "Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `${apiBaseUrl}/desktop/auth/requests/${encodeURIComponent(requestId)}/deny`,
        {
          method: "POST",
          credentials: "include",
          // An explicit empty JSON body rather than none at all: a POST that
          // arrives with a content type Fastify has no parser for is refused
          // with a 415 before the route is ever reached, and "denied" failing
          // silently is the one outcome this page must not have.
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setPhase("gone");
        setStatus("error", describe(payload, "That request is no longer waiting."));
        return;
      }
      setPhase("denied");
    } catch {
      setStatus("error", "Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // Back to this exact page, request id included, after the normal login — which
  // is what makes Google sign-in work for a desktop that cannot run the redirect.
  const returnTo = `/desktop/authorize${requestId ? `?request=${encodeURIComponent(requestId)}` : ""}`;

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
            <h1 id="auth-title">Approve a desktop sign-in</h1>
            <p>
              {phase === "approved"
                ? "That computer is now signed in to your account."
                : phase === "denied"
                  ? "Nothing was granted to that computer."
                  : "A copy of Onshell Desktop is asking to sign in as you."}
            </p>
          </div>

          {message && (
            <p className={`auth-message ${tone}`} role="status" aria-live="polite">
              {message}
            </p>
          )}

          {phase === "checking" && (
            <p className="auth-hint">
              <span className="auth-spinner" aria-hidden="true" /> Checking your session…
            </p>
          )}

          {phase === "missing" && (
            <>
              <p className="auth-hint">
                This page needs a sign-in request to approve, and the address does not name one. Open Onshell
                Desktop and choose <strong>Sign in with browser</strong>; it will bring you back here.
              </p>
              <Link className="secondary-button full-width" href="/desktop">
                About Onshell Desktop
              </Link>
            </>
          )}

          {phase === "signed-out" && (
            <>
              <p className="auth-hint">
                Sign in first, and you will come straight back here to approve the request. Google sign-in
                works here even though the app cannot offer it.
              </p>
              <Link
                className="primary-button large full-width"
                href={`/login?next=${encodeURIComponent(returnTo)}`}
              >
                <ShieldCheck size={17} aria-hidden="true" />
                Sign in to continue
              </Link>
              <p className="auth-alt">
                No account yet? <Link href="/signup">Create one</Link>
              </p>
            </>
          )}

          {phase === "gone" && (
            <>
              <p className="auth-hint">
                That request has expired or has already been answered. Requests last five minutes, which is
                deliberate — an approval waiting around is an approval somebody else could use.
              </p>
              <p className="auth-hint">Start a new one from the app and reopen the page it gives you.</p>
            </>
          )}

          {phase === "ready" && preview && (
            <>
              <dl className="dauth-facts">
                <div>
                  <dt>Machine</dt>
                  <dd>
                    <Laptop size={15} aria-hidden="true" />
                    <span>{preview.machineName}</span>
                  </dd>
                </div>
                <div>
                  <dt>System</dt>
                  <dd>
                    <span>
                      {platformLabel(preview.platform)}
                      {preview.appVersion ? ` · Onshell Desktop ${preview.appVersion}` : ""}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Requested</dt>
                  <dd>
                    <span>{new Date(preview.requestedAt).toLocaleTimeString()}</span>
                  </dd>
                </div>
              </dl>

              <p className="auth-hint">
                The machine name is what that computer said about itself, not something we can verify.{" "}
                <strong>If you did not just start this from that computer, deny it.</strong>
              </p>

              <form className="auth-form" onSubmit={approve} noValidate>
                <div className="auth-field">
                  <label htmlFor="dauth-code">Code shown in the app window</label>
                  <div className="auth-input-wrap">
                    <ShieldCheck size={17} aria-hidden="true" />
                    <input
                      id="dauth-code"
                      className="auth-input has-icon auth-code"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={16}
                      placeholder="WXYZ-4821"
                      value={userCode}
                      onChange={(event) => setUserCode(event.target.value.toUpperCase())}
                      required
                      autoFocus
                    />
                  </div>
                </div>

                <p className="auth-hint">
                  Approving gives that computer a signed-in session for this account — the same access you
                  have in this browser. It can be ended at any time by signing out from the app, or from your
                  console.
                </p>

                <button
                  className="primary-button large full-width"
                  type="submit"
                  disabled={busy || userCode.trim().length < 8}
                >
                  {busy ? <span className="auth-spinner" aria-hidden="true" /> : <Check size={17} />}
                  {busy ? "Approving…" : "Approve this computer"}
                </button>
              </form>

              <button
                className="secondary-button full-width"
                type="button"
                onClick={() => void deny()}
                disabled={busy}
              >
                <X size={16} aria-hidden="true" />
                Deny
              </button>
            </>
          )}

          {phase === "approved" && (
            <>
              <p className="auth-message success" role="status">
                <Check size={15} aria-hidden="true" /> Approved. The app window should have signed itself in
                within a couple of seconds.
              </p>
              <p className="auth-hint">
                You can close this tab. If the app is still waiting, bring it to the front — it collects the
                session itself and nothing needs to be copied back.
              </p>
              <Link className="secondary-button full-width" href="/console">
                Go to your console
              </Link>
            </>
          )}

          {phase === "denied" && (
            <>
              <p className="auth-message error" role="status">
                <AlertTriangle size={15} aria-hidden="true" /> Denied. That computer was given nothing.
              </p>
              <p className="auth-hint">
                If you did not start this request, it is worth changing your password — somebody knew enough
                to send you this page.
              </p>
              <Link className="secondary-button full-width" href="/console">
                Go to your console
              </Link>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
