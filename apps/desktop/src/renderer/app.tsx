/**
 * Which screen to show, decided entirely from the state the main process pushes.
 *
 * The renderer holds no session of its own. If the main process clears the
 * session — the refresh token was revoked, the user signed out, the server
 * changed — the next push takes this window back to sign-in without the UI
 * having to notice or agree.
 */
import { useEffect, useState } from "react";
import { bridge } from "./bridge.js";
import type { AppState } from "../shared/ipc.js";
import { ServerSetup } from "./screens/server-setup.js";
import { SignIn } from "./screens/sign-in.js";
import { Console } from "./screens/console.js";

export function App() {
  const [state, setState] = useState<AppState>();
  const [changingServer, setChangingServer] = useState(false);

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
  if (!state) return null;

  if (!state.server || changingServer) return <ServerSetup />;

  if (!state.user) {
    return (
      <SignIn
        serverLabel={state.server.label}
        keychainAvailable={state.keychainAvailable}
        onChangeServer={() => setChangingServer(true)}
      />
    );
  }

  return <Console state={state} />;
}
