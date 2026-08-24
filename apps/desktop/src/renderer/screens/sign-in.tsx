/**
 * Sign-in: from the browser, or with a password, plus the second factor.
 *
 * The password never leaves this process except as an argument to one IPC call;
 * the main process posts it and keeps the tokens. Nothing here stores anything.
 *
 * The browser path is offered first, and not for fashion: an account created
 * with Google has no password to type, and a deployment with bot protection
 * turned on cannot be signed into from a native window at all. Both of those
 * used to end at a rejected password with no explanation. The user code shown
 * below is the security-relevant part of it — the person types it into the
 * browser, which is what proves the approval belongs to the machine that asked.
 */
import { useEffect, useState, type FormEvent } from "react";
import { bridge, type TwoFactorChallenge } from "../bridge.js";
import type { BrowserSignInStart } from "../../shared/ipc.js";

interface Props {
  serverLabel: string;
  keychainAvailable: boolean;
  onChangeServer(): void;
}

/** The waiting state, narrowed to the successful half of the start result. */
type PendingBrowserSignIn = Extract<BrowserSignInStart, { ok: true }>;

function secondsLeft(expiresAt: string) {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function SignIn({ serverLabel, keychainAvailable, onChangeServer }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<TwoFactorChallenge>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [browser, setBrowser] = useState<PendingBrowserSignIn>();
  const [remaining, setRemaining] = useState(0);

  // A window closed or a server changed mid-wait must not leave the main process
  // polling for a request nothing is listening for any more.
  useEffect(() => () => void bridge.auth.cancelBrowserSignIn(), []);

  useEffect(() => {
    if (!browser) return;
    setRemaining(secondsLeft(browser.expiresAt));
    const timer = window.setInterval(() => setRemaining(secondsLeft(browser.expiresAt)), 1000);
    return () => window.clearInterval(timer);
  }, [browser]);

  async function startBrowserSignIn() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const started = await bridge.auth.startBrowserSignIn();
    setBusy(false);
    if (!started.ok) {
      setError(started.error);
      return;
    }

    setBrowser(started);
    const outcome = await bridge.auth.awaitBrowserSignIn();
    if (outcome.status === "approved") return; // State push unmounts this screen.

    setBrowser(undefined);
    if (outcome.status === "denied") {
      setError("That sign-in was refused in the browser. Nothing was granted to this computer.");
    } else if (outcome.status === "expired") {
      setError("That request expired before it was approved. Start a new one.");
    } else if (outcome.status === "failed") {
      setError(outcome.error);
    }
    // "cancelled" is the user's own doing and needs no message.
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await bridge.auth.signIn({ email: email.trim(), password });
    setBusy(false);

    if (result.ok) return; // State push unmounts this screen.
    if ("challenge" in result) {
      setChallenge(result.challenge);
      setNotice(result.challenge.message);
      // Held only until the code is entered — the second leg authenticates on
      // the challenge id, not on the password again.
      setPassword("");
      return;
    }
    setError(result.error);
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(undefined);
    const result = await bridge.auth.completeTwoFactor(challenge.challengeId, code.trim());
    setBusy(false);
    if (result.ok) return;
    setError("challenge" in result ? "That code was not accepted." : result.error);
  }

  if (browser) {
    return (
      <div className="gate">
        <div className="gate__card">
          <div className="gate__brand">
            <strong>Waiting for your browser</strong>
            <span>{serverLabel}</span>
          </div>
          <p className="gate__lead">
            Your browser should have opened. Sign in there if you are not already, then type this code to
            approve this computer.
          </p>

          <div className="gate__code">
            <span>Code to type</span>
            <strong>{browser.userCode}</strong>
          </div>

          <p className="hint">
            Only ever type this code into a page you reached from this window. Onshell will never ask for it
            over email, chat, or the phone.
          </p>

          {remaining > 0 ? (
            <p className="hint">
              This code expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}.
            </p>
          ) : (
            <p className="hint">This code has expired. Cancel and start again.</p>
          )}

          <div className="gate__actions">
            <button
              className="button button--ghost"
              type="button"
              onClick={() => void bridge.openExternal(browser.verificationUrl)}
            >
              Open the page again
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                void bridge.auth.cancelBrowserSignIn();
                setBrowser(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (challenge) {
    return (
      <div className="gate">
        <form className="gate__card" onSubmit={submitCode}>
          <div className="gate__brand">
            <strong>Two-factor</strong>
          </div>
          <p className="gate__lead">
            {notice ??
              (challenge.method === "email"
                ? "Enter the 6-digit code we emailed to you."
                : "Enter the 6-digit code from your authenticator app.")}
          </p>

          <div className="field">
            <label htmlFor="code">Verification code</label>
            <input
              id="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              autoFocus
            />
          </div>

          {error && <p className="error">{error}</p>}

          <div className="gate__actions">
            <button className="button button--primary" type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            {challenge.method === "email" && (
              <button
                className="button button--ghost"
                type="button"
                disabled={busy}
                onClick={() => {
                  void bridge.auth.resendCode(challenge.challengeId).then((sent) => {
                    setNotice(sent ? "A new code is on its way." : "Could not send another code just now.");
                  });
                }}
              >
                Send another code
              </button>
            )}
            <button
              className="button button--ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                setChallenge(undefined);
                setCode("");
                setError(undefined);
              }}
            >
              Back
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="gate">
      <div className="gate__card">
        <div className="gate__brand">
          <strong>Sign in</strong>
          <span>{serverLabel}</span>
        </div>
        <p className="gate__lead">Your hosts, credentials, and team come from this server.</p>

        {/* Above both paths, because either one can produce it. */}
        {error && <p className="error">{error}</p>}

        <button
          className="button button--primary button--block"
          type="button"
          disabled={busy}
          onClick={() => void startBrowserSignIn()}
        >
          {busy ? "Opening your browser…" : "Sign in with browser"}
        </button>
        <p className="hint gate__hint">
          Opens onshell in your normal browser, where Google sign-in and an existing session already work.
          You approve this computer there with a code shown here.
        </p>

        <div className="gate__divider">
          <span>or use a password</span>
        </div>

        <form onSubmit={submitPassword}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>

          <div className="gate__actions">
            <button
              className="button"
              type="submit"
              disabled={busy || email.trim().length === 0 || password.length === 0}
            >
              {busy ? "Signing in…" : "Sign in with password"}
            </button>
            <button className="button button--ghost" type="button" onClick={onChangeServer} disabled={busy}>
              Change server
            </button>
          </div>
        </form>

        {!keychainAvailable && (
          <div className="gate__footer">
            <p className="hint">
              This system has no usable keychain, so the session is kept in memory and you will be asked to
              sign in again next launch. Writing it to a plain file instead would leave a month-long
              credential readable by anything running as you.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
