/**
 * Sign-in, including the second factor.
 *
 * The password never leaves this process except as an argument to one IPC call;
 * the main process posts it and keeps the tokens. Nothing here stores anything.
 */
import { useState, type FormEvent } from "react";
import { bridge, type TwoFactorChallenge } from "../bridge.js";

interface Props {
  serverLabel: string;
  keychainAvailable: boolean;
  onChangeServer(): void;
}

export function SignIn({ serverLabel, keychainAvailable, onChangeServer }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<TwoFactorChallenge>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

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
      <form className="gate__card" onSubmit={submitPassword}>
        <div className="gate__brand">
          <strong>Sign in</strong>
          <span>{serverLabel}</span>
        </div>
        <p className="gate__lead">Your hosts, credentials, and team come from this server.</p>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
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

        {error && <p className="error">{error}</p>}

        <div className="gate__actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || email.trim().length === 0 || password.length === 0}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <button className="button button--ghost" type="button" onClick={onChangeServer} disabled={busy}>
            Change server
          </button>
        </div>

        {!keychainAvailable && (
          <div className="gate__footer">
            <p className="hint">
              This system has no usable keychain, so the session is kept in memory and you will be asked to
              sign in again next launch. Writing it to a plain file instead would leave a month-long
              credential readable by anything running as you.
            </p>
          </div>
        )}
      </form>
    </div>
  );
}
