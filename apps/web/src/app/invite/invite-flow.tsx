"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import {
  Building2,
  Check,
  Circle,
  Eye,
  EyeOff,
  KeyRound,
  LogIn,
  MailX,
  RotateCw,
  UserPlus,
  UserRound
} from "lucide-react";
import type { InvitationPreview, Role } from "@onshell/api-client";
import { passwordPolicy, validatePassword } from "@onshell/shared";
import { apiBaseUrl } from "../../lib/site";
import { OnshellMark } from "../brand";
import { ThemeToggle } from "../theme";
import "../auth.css";

type Stage = "loading" | "failed" | "ready" | "joined";
type Tone = "info" | "error" | "success";

/** A dead end, rendered in place of the form. `retryable` earns a reload button. */
type Failure = { title: string; body: string; retryable?: boolean };

type PasswordRequirement = { label: string; met: boolean };

const EXPIRED: Failure = {
  title: "This invitation is no longer valid",
  body: "Invitation links last seven days and work only once. Ask whoever invited you to send a fresh one from Team settings in their console."
};

const MISSING_TOKEN: Failure = {
  title: "This link is missing its invitation code",
  body: "Open the link straight from the invitation email rather than typing it out — the code after the question mark is what identifies your invitation."
};

/**
 * What the role actually buys them, in one line. An invitation is the first
 * thing many people ever see of Onshell, and "auditor" means nothing on its own.
 */
const roleBlurbs: Record<Role, string> = {
  owner: "Full control of the workspace, including billing and who else can join.",
  admin: "Manage hosts, credentials, and people across the whole workspace.",
  devops: "Manage hosts and credentials, and open a session on any of them.",
  developer: "Open SSH, SFTP, and RDP sessions on the hosts you are given.",
  auditor: "Read-only access to session history and audit logs. No connections."
};

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
    case "invalid_or_expired_invitation":
    case "invitation_not_found":
      return "That invitation has expired or has already been used.";
    case "name_and_password_required":
      return "Enter your name and a password to finish setting up your account.";
    case "password_policy_violation":
      return "Please choose a stronger password.";
    case "validation_failed":
      return "That invitation link looks incomplete. Open it again from the email.";
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

/**
 * Absolute date plus the countdown, because neither alone is enough: "Mar 3"
 * does not say whether that is tomorrow, and "in 6 days" is useless once the
 * page has been left open overnight.
 */
function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Soon";

  const absolute = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return `${absolute} — today`;
  if (days === 1) return `${absolute} — tomorrow`;
  return `${absolute} — in ${days} days`;
}

export function InviteFlow() {
  const reduceMotion = useReducedMotion();

  const [stage, setStage] = useState<Stage>("loading");
  const [failure, setFailure] = useState<Failure>(EXPIRED);
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<InvitationPreview | null>(null);

  const [busy, setBusy] = useState(false);
  const [tone, setTone] = useState<Tone>("info");
  const [message, setMessage] = useState("");

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  /** Policy failures as the server worded them, shown against the field. */
  const [policyErrors, setPolicyErrors] = useState<string[]>([]);

  const needsAccount = preview !== null && !preview.existingUser;
  const passwordValid = validatePassword(password).valid;
  const confirmMismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const canSubmit =
    !busy &&
    preview !== null &&
    (!needsAccount || (name.trim().length >= 2 && passwordValid && confirmPassword === password));

  function setStatus(nextTone: Tone, nextMessage: string) {
    setTone(nextTone);
    setMessage(nextMessage);
  }

  // The token is read from the browser on mount rather than through
  // useSearchParams, which is how /login and /signup read their query too: the
  // value is only ever needed after hydration, and reading it with the hook
  // would put this whole card behind a Suspense boundary to no benefit.
  useEffect(() => {
    const urlToken = new URLSearchParams(window.location.search).get("token")?.trim() ?? "";
    if (!urlToken) {
      setFailure(MISSING_TOKEN);
      setStage("failed");
      return;
    }
    setToken(urlToken);

    // The visitor can reload before the lookup lands, and an unmounted card
    // must not be the thing that decides what the next one renders.
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/invitations/lookup?token=${encodeURIComponent(urlToken)}`);
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;

        if (!response.ok) {
          setFailure(
            response.status === 429
              ? {
                  title: "Too many attempts from this network",
                  body: "We stopped checking invitations from here for a moment. Wait a minute, then try the link again.",
                  retryable: true
                }
              : response.status >= 500
                ? {
                    title: "We couldn't check your invitation",
                    body: "Something went wrong on our side, not yours. The link is untouched — try again in a moment.",
                    retryable: true
                  }
                : EXPIRED
          );
          setStage("failed");
          return;
        }

        setPreview(payload as InvitationPreview);
        setStage("ready");
      } catch {
        if (cancelled) return;
        setFailure({
          title: "We couldn't reach Onshell",
          body: "Your invitation is fine — the browser could not get to our API. Check your connection and try again.",
          retryable: true
        });
        setStage("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview) return;

    if (needsAccount) {
      if (!passwordValid) {
        setStatus("error", "Please choose a password that meets every requirement.");
        return;
      }
      if (confirmPassword !== password) {
        setStatus("error", "Those passwords don't match.");
        return;
      }
    }

    setBusy(true);
    setMessage("");
    setPolicyErrors([]);
    try {
      const response = await fetch(`${apiBaseUrl}/invitations/accept`, {
        method: "POST",
        // The new-account branch answers with session cookies, so the browser
        // has to be allowed to keep them — this request *is* the sign-in.
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          ...(needsAccount ? { name: name.trim(), password } : {})
        })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Revoked, or accepted in another tab, between the preview and now.
        // Nothing on this page fixes that, so stop offering the form.
        if (payload.error === "invalid_or_expired_invitation") {
          setFailure(EXPIRED);
          setStage("failed");
          return;
        }
        if (payload.error === "password_policy_violation" && Array.isArray(payload.errors)) {
          setPolicyErrors(payload.errors as string[]);
          setStatus("error", "That password doesn't meet the policy for this workspace.");
          return;
        }
        setStatus("error", errorText(payload, "We couldn't accept that invitation."));
        return;
      }

      // Two shapes come back: an existing account gets the membership and
      // nothing else, while a new one gets a session and can go straight in.
      if (payload.requiresLogin) {
        setStage("joined");
        setStatus("success", `You have been added to ${preview.organizationName}.`);
        return;
      }

      setStatus("success", "Account created. Redirecting to your console…");
      window.location.href = "/console";
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

  function heading(): { title: string; subtitle: string } {
    if (stage === "loading") {
      return {
        title: "Checking your invitation…",
        subtitle: "One moment while we look up the workspace that invited you."
      };
    }
    if (stage === "failed") {
      return { title: failure.title, subtitle: failure.body };
    }
    if (stage === "joined") {
      return {
        title: "You're in",
        subtitle: `${preview?.organizationName ?? "The workspace"} has been added to your Onshell account. Sign in to open it.`
      };
    }
    return {
      title: `Join ${preview?.organizationName ?? "your team"}`,
      subtitle: needsAccount
        ? "Pick a name and a password and your account is ready — nothing else to fill in."
        : "You already have an Onshell account on this address. Accepting adds this workspace to it."
    };
  }

  const { title, subtitle } = heading();

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
            <h1 id="auth-title">{title}</h1>
            <p>{subtitle}</p>
          </div>

          {message && (
            <p className={`auth-message ${tone}`} role="status" aria-live="polite">
              {message}
            </p>
          )}

          {stage === "loading" && (
            <div className="invite-loading" role="status">
              <span className="auth-spinner" aria-hidden="true" />
              <span className="sr-only">Loading your invitation</span>
            </div>
          )}

          {stage === "failed" && (
            <>
              <p className="invite-dead-end">
                <MailX size={17} aria-hidden="true" />
                <span>
                  {failure.retryable
                    ? "Nothing has been used up — the link still works."
                    : "Invitation links are single-use, so this one cannot be reopened."}
                </span>
              </p>

              {failure.retryable ? (
                <button
                  className="primary-button large full-width"
                  type="button"
                  onClick={() => window.location.reload()}
                >
                  <RotateCw size={17} />
                  Try again
                </button>
              ) : (
                <Link className="secondary-button large full-width" href="/login">
                  <LogIn size={17} />
                  Go to sign in
                </Link>
              )}

              <p className="auth-alt">
                No account yet? <Link href="/signup">Create a free workspace</Link>
              </p>
            </>
          )}

          {stage === "joined" && (
            <>
              <Link className="primary-button large full-width" href="/login">
                <LogIn size={17} />
                Sign in to continue
              </Link>
              <p className="auth-fineprint">
                Sign in with the password you already use for Onshell. Your new workspace is waiting in the
                switcher at the top of the console.
              </p>
            </>
          )}

          {stage === "ready" && preview && (
            <form className="auth-form" onSubmit={accept} noValidate>
              <dl className="invite-summary">
                <div className="invite-summary-row">
                  <dt>Workspace</dt>
                  <dd>
                    <Building2 size={15} aria-hidden="true" />
                    {preview.organizationName}
                  </dd>
                </div>
                <div className="invite-summary-row">
                  <dt>Your role</dt>
                  <dd>
                    <span className="invite-role">{preview.role}</span>
                  </dd>
                </div>
                <div className="invite-summary-row">
                  <dt>Invited address</dt>
                  <dd>{preview.email}</dd>
                </div>
                <div className="invite-summary-row">
                  <dt>Link expires</dt>
                  <dd>{formatExpiry(preview.expiresAt)}</dd>
                </div>
              </dl>

              <p className="auth-hint">{roleBlurbs[preview.role]}</p>

              {needsAccount && (
                <>
                  <div className="auth-field">
                    <label htmlFor="invite-name">Full name</label>
                    <div className="auth-input-wrap">
                      <UserRound size={17} aria-hidden="true" />
                      <input
                        id="invite-name"
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
                    <label htmlFor="invite-password">Password</label>
                    <div className="auth-input-wrap">
                      <KeyRound size={17} aria-hidden="true" />
                      <input
                        id="invite-password"
                        className="auth-input has-icon has-reveal"
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        aria-describedby="invite-pw-reqs"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          // The server's verdict was about the old value.
                          setPolicyErrors([]);
                        }}
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
                    <PasswordStrength password={password} describedById="invite-pw-reqs" />
                    {policyErrors.map((policyError) => (
                      <span key={policyError} className="auth-hint error">
                        {policyError}
                      </span>
                    ))}
                  </div>

                  <div className="auth-field">
                    <label htmlFor="invite-confirm">Confirm password</label>
                    <div className="auth-input-wrap">
                      <KeyRound size={17} aria-hidden="true" />
                      <input
                        id="invite-confirm"
                        className="auth-input has-icon"
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        aria-describedby={confirmMismatch ? "invite-confirm-hint" : undefined}
                        aria-invalid={confirmMismatch}
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        required
                      />
                    </div>
                    {confirmMismatch && (
                      <span id="invite-confirm-hint" className="auth-hint error">
                        Those passwords don&apos;t match.
                      </span>
                    )}
                  </div>
                </>
              )}

              <button className="primary-button large full-width" type="submit" disabled={!canSubmit}>
                {busy ? (
                  <span className="auth-spinner" aria-hidden="true" />
                ) : needsAccount ? (
                  <UserPlus size={17} />
                ) : (
                  <LogIn size={17} />
                )}
                {busy
                  ? needsAccount
                    ? "Creating your account…"
                    : "Accepting…"
                  : needsAccount
                    ? "Create account and join"
                    : "Accept and continue"}
              </button>

              {needsAccount ? (
                <p className="auth-fineprint">
                  Your account is created on the invited address above. You can add two-factor authentication
                  from your profile once you are in.
                </p>
              ) : (
                <p className="auth-fineprint">
                  Accepting adds this workspace to your existing account. Nothing about your current sign-in
                  changes.
                </p>
              )}
            </form>
          )}
        </motion.section>
      </div>
    </main>
  );
}
