/**
 * Which screen to show, decided entirely from the state the main process pushes.
 *
 * The renderer holds no session of its own. If the main process clears the
 * session — the refresh token was revoked, the user signed out, the server
 * changed — the next push takes this window back to sign-in without the UI
 * having to notice or agree.
 */
import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    return subscribeActivity(setPending);
  }, []);

  useEffect(() => {
    void bridge.getState().then(setState);
    return bridge.onState((next) => {
      setState(next);
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
  if (!state) screen = null;
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
      {screen}
      <AppActivity active={!state || pending > 0} logoUrl={logoUrl} />
    </>
  );
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
