/**
 * The signed-in workspace: this machine on the left with the saved hosts, and
 * terminal tabs across the top.
 *
 * "This computer" is listed first and deliberately looks like any other host.
 * That is the claim the app is making — your own machine is a place you can open
 * a shell on, next to the servers, without a tunnel or a round trip.
 */
import { useEffect, useMemo, useState } from "react";
import { bridge, type LocalShell, type TerminalOpened } from "../bridge.js";
import type { AppState, FileSessionTargetRequest } from "../../shared/ipc.js";
import type { Host, Snippet } from "@onshell/api-client";
import { TerminalPane } from "../terminal.js";
import { Files } from "./files.js";
import { Settings } from "./settings.js";

interface Props {
  state: AppState;
}

interface Tab extends TerminalOpened {
  closed?: boolean;
}

type Overlay =
  | { kind: "none" }
  | { kind: "settings" }
  | { kind: "files"; target: FileSessionTargetRequest; label: string };

export function Console({ state }: Props) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [query, setQuery] = useState("");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [error, setError] = useState<string>();
  const [relayOffer, setRelayOffer] = useState<{ host: Host; reason: string }>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Shells first and separately: they come from this machine and must appear
    // even when the server is slow or unreachable, which is the whole point of
    // the local terminal.
    void bridge.terminals.localShells().then((found) => {
      if (!cancelled) setShells(found);
    });
    void bridge.console.snippets().then(
      (found) => {
        if (!cancelled) setSnippets(found);
      },
      () => undefined
    );
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

  const visibleHosts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? hosts.filter((host) =>
          [host.name, host.address, host.username, ...(host.tags ?? [])]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(needle))
        )
      : hosts;
    // Pinned hosts first, then alphabetical — the order someone who pinned
    // anything is expecting to see.
    return matches
      .slice()
      .sort((a, b) => Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite)) || a.name.localeCompare(b.name));
  }, [hosts, query]);

  const activeTab = tabs.find((tab) => tab.terminalId === activeId);

  function accept(result: Awaited<ReturnType<typeof bridge.terminals.open>>) {
    if (!result.ok) return false;
    setTabs((current) => [...current, result.terminal]);
    setActiveId(result.terminal.terminalId);
    setOverlay({ kind: "none" });
    return true;
  }

  async function openLocal(shellId?: string) {
    setError(undefined);
    const result = await bridge.terminals.open({ kind: "local", shellId });
    if (!accept(result) && !result.ok) setError(result.error);
  }

  async function openHost(host: Host) {
    setError(undefined);
    setRelayOffer(undefined);
    const result = await bridge.terminals.open({
      kind: state.connectionMode === "direct" ? "direct" : "relay",
      hostId: host.id
    });
    if (result.ok) {
      accept(result);
      return;
    }

    // A direct connection that failed is a question, not just an error: going
    // through the gateway would probably work, but it means Onshell is on the
    // wire, and that is the user's call rather than a silent substitution.
    if (result.canRelay) setRelayOffer({ host, reason: result.error });
    else setError(result.error);
  }

  async function openThroughGateway(host: Host) {
    setRelayOffer(undefined);
    setError(undefined);
    const result = await bridge.terminals.open({ kind: "relay", hostId: host.id });
    if (!accept(result) && !result.ok) setError(result.error);
  }

  async function toggleFavorite(host: Host) {
    const next = !host.isFavorite;
    // Optimistic: pinning is trivially reversible and a spinner on a star is
    // more disruptive than the rare failure it would report.
    setHosts((current) =>
      current.map((candidate) => (candidate.id === host.id ? { ...candidate, isFavorite: next } : candidate))
    );
    try {
      await bridge.console.setFavorite(host.id, next);
    } catch {
      setHosts((current) =>
        current.map((candidate) =>
          candidate.id === host.id ? { ...candidate, isFavorite: !next } : candidate
        )
      );
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

  /** Pastes a snippet into the focused terminal, without pressing return. */
  function sendSnippet(snippet: Snippet) {
    if (!activeId) {
      setError("Open a terminal first, then send a snippet to it.");
      return;
    }
    // Deliberately not newline-terminated: a snippet that ran the moment it was
    // clicked would be a one-click way to execute something on production.
    bridge.terminals.write(activeId, snippet.command);
  }

  return (
    <div className="console">
      <aside className="sidebar">
        <div className="sidebar__head">
          <div className="sidebar__account">{state.user?.name ?? state.user?.email ?? "Signed in"}</div>
          <div className="sidebar__server">{state.server?.label}</div>
        </div>

        <div className="sidebar__search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search hosts"
            spellCheck={false}
          />
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
          {!loading && visibleHosts.length === 0 && (
            <div className="host host__meta">{query ? "Nothing matches." : "No hosts saved yet."}</div>
          )}
          {visibleHosts.map((host) => (
            <div key={host.id} className="host host--row">
              <button className="host__open" onClick={() => void openHost(host)}>
                <div className="host__name">{host.name}</div>
                <div className="host__meta">
                  {host.username ? `${host.username}@` : ""}
                  {host.address}
                  {host.port && host.port !== 22 ? `:${host.port}` : ""}
                </div>
              </button>
              <div className="host__actions">
                <button
                  className="icon"
                  title={host.isFavorite ? "Unpin" : "Pin"}
                  onClick={() => void toggleFavorite(host)}
                >
                  {host.isFavorite ? "★" : "☆"}
                </button>
                <button
                  className="icon"
                  title="Browse files"
                  onClick={() =>
                    setOverlay({
                      kind: "files",
                      label: host.name,
                      target: { kind: state.connectionMode === "direct" ? "direct" : "relay", hostId: host.id }
                    })
                  }
                >
                  ⇄
                </button>
              </div>
            </div>
          ))}

          {snippets.length > 0 && (
            <>
              <div className="sidebar__section">Snippets</div>
              {snippets.map((snippet) => (
                <button
                  key={snippet.id}
                  className="host"
                  onClick={() => sendSnippet(snippet)}
                  title={snippet.command}
                >
                  <div className="host__name">{snippet.name}</div>
                  <div className="host__meta">types into the open terminal</div>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="sidebar__foot">
          <button className="button button--ghost" onClick={() => setOverlay({ kind: "settings" })}>
            Settings
          </button>
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
                className={`tab${tab.terminalId === activeId && overlay.kind === "none" ? " tab--active" : ""}`}
                onClick={() => {
                  setActiveId(tab.terminalId);
                  setOverlay({ kind: "none" });
                }}
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

        {relayOffer && (
          <div className="banner">
            <strong>{relayOffer.host.name}</strong> could not be reached directly from this machine —{" "}
            {relayOffer.reason} Connecting through the Onshell gateway will work, but that traffic passes
            through our servers rather than going straight to your host.
            <span className="banner__actions">
              <button className="button button--primary" onClick={() => void openThroughGateway(relayOffer.host)}>
                Use the gateway
              </button>
              <button className="button button--ghost" onClick={() => setRelayOffer(undefined)}>
                Cancel
              </button>
            </span>
          </div>
        )}

        <div className="surface">
          {/* Terminals stay mounted underneath an overlay: unmounting one would
              throw away its scrollback, and a shell whose history vanishes when
              you glance at the file browser is not a terminal anyone wants. */}
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.terminalId}
              terminalId={tab.terminalId}
              appearance={state.appearance}
              visible={overlay.kind === "none" && tab.terminalId === activeId}
            />
          ))}

          {overlay.kind === "settings" && <Settings state={state} onClose={() => setOverlay({ kind: "none" })} />}

          {overlay.kind === "files" && (
            <Files
              remote={overlay.target}
              hostLabel={overlay.label}
              onClose={() => setOverlay({ kind: "none" })}
            />
          )}

          {overlay.kind === "none" && !activeTab && (
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
          )}
        </div>
      </main>
    </div>
  );
}
