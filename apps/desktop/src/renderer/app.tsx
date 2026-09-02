/**
 * Which screen to show, decided entirely from the state the main process pushes.
 *
 * The renderer holds no session of its own. If the main process clears the
 * session — the refresh token was revoked, the user signed out, the server
 * changed — the next push takes this window back to sign-in without the UI
 * having to notice or agree.
 */
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { bridge, subscribeActivity } from "./bridge.js";
import type { AppState } from "../shared/ipc.js";
import logoUrl from "../../build/icon.png";
import { ServerSetup } from "./screens/server-setup.js";
import { SignIn } from "./screens/sign-in.js";
import { Console } from "./screens/console.js";

export function App() {
  const [state, setState] = useState<AppState>();
  const [changingServer, setChangingServer] = useState(false);
  const [pending, setPending] = useState(0);
  const [bootError, setBootError] = useState<string>();

  useEffect(() => {
    return subscribeActivity(setPending);
  }, []);

  useEffect(() => {
    void bridge.getState().then(
      (next) => {
        setState(next);
        setBootError(undefined);
      },
      () => setBootError("The desktop service did not answer. Choose the server again to reconnect.")
    );
    return bridge.onState((next) => {
      setState(next);
      setBootError(undefined);
      // A successful server change lands here; drop the override so the normal
      // routing takes over rather than stranding the user on the setup screen.
      if (next.server) setChangingServer(false);
    });
  }, []);

  useEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    if (state.appearance.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", state.appearance.theme);
  }, [state?.appearance.theme, state]);

  // Nothing renders until the first state arrives — a flash of the sign-in
  // screen for an already-signed-in user reads as having been signed out.
  let screen;
  if (!state && bootError) screen = <ServerSetup initialError={bootError} />;
  else if (!state) screen = null;
  else if (!state.server || changingServer) screen = <ServerSetup />;
  else if (!state.user) {
    screen = (
      <SignIn
        serverLabel={state.server.label}
        keychainAvailable={state.keychainAvailable}
        onChangeServer={() => setChangingServer(true)}
      />
    );
  } else screen = <Console state={state} />;

  return (
    <>
      <ScreenBoundary onChangeServer={() => setChangingServer(true)}>{screen}</ScreenBoundary>
      <AppActivity active={(!state && !bootError) || pending > 0} logoUrl={logoUrl} />
    </>
  );
}

class ScreenBoundary extends Component<
  { children: ReactNode; onChangeServer(): void },
  { error: boolean }
> {
  state = { error: false };

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Onshell screen failed to render", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="gate">
        <div className="gate__card" role="alert">
          <div className="gate__brand"><strong>Onshell could not open this screen</strong><span>Desktop recovery</span></div>
          <p className="gate__lead">Your settings and terminals were not changed. Reload the interface, or choose the server again.</p>
          <div className="gate__actions">
            <button className="button button--primary" onClick={() => window.location.reload()} type="button">Reload Onshell</button>
            <button className="button button--ghost" onClick={() => { this.setState({ error: false }); this.props.onChangeServer(); }} type="button">Change server</button>
          </div>
        </div>
      </div>
    );
  }
}

function AppActivity({ active, logoUrl }: { active: boolean; logoUrl: string }) {
  const [visible, setVisible] = useState(active);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (active) {
      setVisible(true);
      return;
    }
    hideTimer.current = window.setTimeout(() => setVisible(false), 240);
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [active]);

  if (!visible) return null;
  return (
    <div className="app-activity" role="status" aria-live="polite" aria-label="Onshell is working">
      <span className="app-activity__mark">
        <img alt="" aria-hidden="true" src={logoUrl} />
      </span>
      <span>Working…</span>
    </div>
  );
}
