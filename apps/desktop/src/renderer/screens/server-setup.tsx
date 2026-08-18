/**
 * First run: which Onshell are we talking to?
 *
 * Asked rather than assumed, because a self-hosted deployment has to work from
 * the same signed installer as the hosted one. The address is verified against
 * the server's own `/health` before it is saved — a typo should be a sentence
 * here, not an unexplained wrong-password screen later.
 */
import { useState, type FormEvent } from "react";
import { bridge } from "../bridge.js";

const HOSTED = "https://onshell.cloud";

export function ServerSetup() {
  const [value, setValue] = useState(HOSTED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function connect(input: string) {
    setBusy(true);
    setError(undefined);
    const result = await bridge.server.use(input);
    // On success the main process pushes new state and this screen unmounts, so
    // there is nothing to do here but stop spinning if it failed.
    if (!result.ok) {
      setError(result.message ?? "Could not reach that server.");
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!busy) void connect(value);
  }

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={onSubmit}>
        <div className="gate__brand">
          <strong>Onshell</strong>
          <span>Desktop</span>
        </div>
        <p className="gate__lead">
          Point this app at an Onshell server. Use the hosted service, or the address of your own
          deployment — the app is not tied to either.
        </p>

        <div className="field">
          <label htmlFor="server">Server address</label>
          <input
            id="server"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://onshell.cloud"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>

        {error && <p className="error">{error}</p>}

        <div className="gate__actions">
          <button className="button button--primary" type="submit" disabled={busy || value.trim().length === 0}>
            {busy ? "Checking…" : "Continue"}
          </button>
          <button
            className="button button--ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              setValue(HOSTED);
              void connect(HOSTED);
            }}
          >
            Use onshell.cloud
          </button>
        </div>

        <div className="gate__footer">
          <p className="hint">
            Running the stack locally?{" "}
            <button
              className="button button--ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void bridge.server.useLocalDevelopment().then((result) => {
                  if (!result.ok) {
                    setError(result.message ?? "No development server is running.");
                    setBusy(false);
                  }
                });
              }}
            >
              Connect to localhost
            </button>
          </p>
        </div>
      </form>
    </div>
  );
}
