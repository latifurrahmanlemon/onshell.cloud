/**
 * The signed-in workspace: this machine on the left with the saved hosts, and
 * terminal tabs across the top.
 *
 * "This computer" is listed first and deliberately looks like any other host.
 * That is the claim the app is making — your own machine is a place you can open
 * a shell on, next to the servers, without a tunnel or a round trip.
 */
import { useEffect, useState } from "react";
import { bridge, type LocalShell, type TerminalOpened } from "../bridge.js";
import type { AppState } from "../../shared/ipc.js";
import type { Host } from "@onshell/api-client";
import { TerminalPane } from "../terminal.js";

interface Props {
  state: AppState;
}

interface Tab extends TerminalOpened {
  closed?: boolean;
}

export function Console({ state }: Props) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Shells first and separately: they come from this machine and must appear
    // even when the server is slow or unreachable, which is the whole point of
    // the local terminal.
    void bridge.terminals.localShells().then((found) => {
      if (!cancelled) setShells(found);
    });
    void bridge.console
      .hosts()
      .then((found) => {
        if (!cancelled) setHosts(found);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load hosts.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // A session that ends on its own — the user typed `exit`, or the process
    // died — should mark its tab, not remove it: the scrollback is often the
    // reason you wanted the terminal in the first place.
    return bridge.terminals.onEvent((event) => {
      if (event.type !== "exit") return;
      setTabs((current) =>
        current.map((tab) => (tab.terminalId === event.terminalId ? { ...tab, closed: true } : tab))
      );
    });
  }, []);

  async function openLocal(shellId?: string) {
    setError(undefined);
    try {
      const opened = await bridge.terminals.open({ kind: "local", shellId });
      setTabs((current) => [...current, opened]);
      setActiveId(opened.terminalId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open that shell.");
    }
  }

  async function openHost(host: Host) {
    setError(undefined);
    try {
      const opened = await bridge.terminals.open({
        kind: state.connectionMode === "direct" ? "direct" : "relay",
        hostId: host.id
      });
      setTabs((current) => [...current, opened]);
      setActiveId(opened.terminalId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open that host.");
    }
  }

  async function closeTab(terminalId: string) {
    await bridge.terminals.close(terminalId);
    setTabs((current) => {
      const next = current.filter((tab) => tab.terminalId !== terminalId);
      setActiveId((active) => (active === terminalId ? next.at(-1)?.terminalId : active));
      return next;
    });
  }

  return (
    <div className="console">
      <aside className="sidebar">
        <div className="sidebar__head">
          <div className="sidebar__account">{state.user?.name ?? state.user?.email ?? "Signed in"}</div>
          <div className="sidebar__server">{state.server?.label}</div>
        </div>

        <div className="sidebar__scroll">
          <div className="sidebar__section">This computer</div>
          {shells.length === 0 && <div className="host host__meta">No shell found on this machine.</div>}
          {shells.map((shell) => (
            <button key={shell.id} className="host" onClick={() => void openLocal(shell.id)} title={shell.command}>
              <div className="host__name">{shell.label}</div>
              <div className="host__meta">local — no network</div>
            </button>
          ))}

          <div className="sidebar__section">Hosts</div>
          {loading && <div className="host host__meta">Loading…</div>}
          {!loading && hosts.length === 0 && <div className="host host__meta">No hosts saved yet.</div>}
          {hosts.map((host) => (
            <button key={host.id} className="host" onClick={() => void openHost(host)}>
              <div className="host__name">{host.name}</div>
              <div className="host__meta">
                {host.username ? `${host.username}@` : ""}
                {host.address}
                {host.port && host.port !== 22 ? `:${host.port}` : ""}
              </div>
            </button>
          ))}
        </div>

        <div className="sidebar__foot">
          <span className="hint">Onshell {state.version}</span>
          <button className="button button--ghost" onClick={() => void bridge.auth.signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="workspace">
        {tabs.length > 0 && (
          <div className="tabs">
            {tabs.map((tab) => (
              <div
                key={tab.terminalId}
                className={`tab${tab.terminalId === activeId ? " tab--active" : ""}`}
                onClick={() => setActiveId(tab.terminalId)}
              >
                <span className={`tab__mode tab__mode--${tab.mode}`}>{tab.mode}</span>
                <span>
                  {tab.title}
                  {tab.closed ? " (ended)" : ""}
                </span>
                <button
                  className="tab__close"
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab.terminalId);
                  }}
                  aria-label={`Close ${tab.title}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <div className="banner">{error}</div>}

        <div className="surface">
          {tabs.length === 0 ? (
            <div className="empty">
              <h2>Open a terminal</h2>
              <p className="hint">
                Pick a shell on this computer, or a saved host. Local shells run here — no server, no
                gateway, no network.
              </p>
              {shells.length > 0 && (
                <div>
                  <button className="button button--primary" onClick={() => void openLocal()}>
                    Open {shells[0].label}
                  </button>
                </div>
              )}
            </div>
          ) : (
            tabs.map((tab) => (
              <TerminalPane
                key={tab.terminalId}
                terminalId={tab.terminalId}
                appearance={state.appearance}
                visible={tab.terminalId === activeId}
              />
            ))
          )}
        </div>
      </main>
    </div>
  );
}
