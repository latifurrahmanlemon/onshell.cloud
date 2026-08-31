/**
 * The signed-in workspace: this machine on the left with the saved hosts, and
 * terminal tabs across the top.
 *
 * "This computer" is listed first and deliberately looks like any other host.
 * That is the claim the app is making — your own machine is a place you can open
 * a shell on, next to the servers, without a tunnel or a round trip.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { bridge, type LocalShell, type TerminalOpened, type TerminalTarget } from "../bridge.js";
import type { AppState, FileSessionTargetRequest } from "../../shared/ipc.js";
import type { AuditLog, CredentialSummary, Host, RemoteSession, Snippet } from "@onshell/api-client";
import { TerminalPane } from "../terminal.js";
import { Files } from "./files.js";
import { Settings } from "./settings.js";
import { Icon } from "../icons.js";
import { CommandPalette, type CommandAction } from "../command-palette.js";
import { HistoryView, VaultView } from "./resource-view.js";

interface Props {
  state: AppState;
}

interface Tab extends TerminalOpened {
  closed?: boolean;
  target: TerminalTarget;
}

type Overlay =
  | { kind: "none" }
  | { kind: "settings" }
  | { kind: "vault" }
  | { kind: "history" }
  | { kind: "files"; target: FileSessionTargetRequest; label: string };

export function Console({ state }: Props) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [audit, setAudit] = useState<AuditLog[]>([]);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [query, setQuery] = useState("");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [error, setError] = useState<string>();
  const [relayOffer, setRelayOffer] = useState<{
    host: Host;
    reason: string;
  }>();
  const [loading, setLoading] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [secondaryId, setSecondaryId] = useState<string>();
  const [savedTargets, setSavedTargets] = useState<TerminalTarget[]>([]);
  const [restoring, setRestoring] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const workspaceTouchedRef = useRef(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Shells first and separately: they come from this machine and must appear
    // even when the server is slow or unreachable, which is the whole point of
    // the local terminal.
    void bridge.terminals.localShells().then((found) => {
      if (!cancelled) setShells(found);
    });
    void bridge.workspace.load().then(
      (saved) => {
        if (!cancelled) {
          setSavedTargets(saved.targets);
          setWorkspaceReady(true);
        }
      },
      () => {
        setWorkspaceReady(true);
      }
    );
    void bridge.console
      .load()
      .then((data) => {
        if (cancelled) return;
        setHosts(data.hosts);
        setSnippets(data.snippets);
        setCredentials(data.credentials);
        setSessions(data.sessions);
        setAudit(data.audit);
      })
      .catch((cause: unknown) => {
        // Audit or session history being unavailable must not make the terminal
        // itself unusable. Fall back to the two lists needed to connect.
        void Promise.allSettled([bridge.console.hosts(), bridge.console.snippets()]).then(
          ([hostResult, snippetResult]) => {
            if (cancelled) return;
            if (hostResult.status === "fulfilled") setHosts(hostResult.value);
            if (snippetResult.status === "fulfilled") setSnippets(snippetResult.value);
            setError(cause instanceof Error ? cause.message : "Some workspace data could not be loaded.");
          }
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void openLocal();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w" && activeId) {
        event.preventDefault();
        void closeTab(activeId);
      }
      if (event.ctrlKey && event.key === "Tab" && tabs.length > 1) {
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.terminalId === activeId);
        const offset = event.shiftKey ? -1 : 1;
        const next = (index + offset + tabs.length) % tabs.length;
        setActiveId(tabs[next]?.terminalId);
        setOverlay({ kind: "none" });
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  });

  useEffect(() => {
    if (!workspaceReady || !workspaceTouchedRef.current) return;
    const targets = tabs.map((tab) => tab.target);
    setSavedTargets(targets);
    void bridge.workspace
      .save(targets)
      .catch(() => setError("The terminal layout is open, but it could not be saved for the next launch."));
  }, [tabs, workspaceReady]);

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

  function accept(result: Awaited<ReturnType<typeof bridge.terminals.open>>, target: TerminalTarget) {
    if (!result.ok) return false;
    workspaceTouchedRef.current = true;
    setTabs((current) => {
      const next = [...current, { ...result.terminal, target }];
      return next;
    });
    setActiveId(result.terminal.terminalId);
    setOverlay({ kind: "none" });
    return true;
  }

  async function openLocal(shellId?: string) {
    setError(undefined);
    const target: TerminalTarget = { kind: "local", shellId };
    const result = await bridge.terminals.open(target);
    if (!accept(result, target) && !result.ok) setError(result.error);
  }

  async function openHost(host: Host) {
    setError(undefined);
    setRelayOffer(undefined);
    const target: TerminalTarget = {
      kind: state.connectionMode === "direct" ? "direct" : "relay",
      hostId: host.id
    };
    const result = await bridge.terminals.open(target);
    if (result.ok) {
      accept(result, target);
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
    const target: TerminalTarget = { kind: "relay", hostId: host.id };
    const result = await bridge.terminals.open(target);
    if (!accept(result, target) && !result.ok) setError(result.error);
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
        current.map((candidate) => (candidate.id === host.id ? { ...candidate, isFavorite: !next } : candidate))
      );
    }
  }

  async function closeTab(terminalId: string) {
    await bridge.terminals.close(terminalId);
    workspaceTouchedRef.current = true;
    setTabs((current) => {
      const next = current.filter((tab) => tab.terminalId !== terminalId);
      setActiveId((active) => (active === terminalId ? next.at(-1)?.terminalId : active));
      return next;
    });
    setSecondaryId((current) => (current === terminalId ? undefined : current));
  }

  async function duplicateTab(tab: Tab) {
    setError(undefined);
    const result = await bridge.terminals.open(tab.target);
    if (!accept(result, tab.target) && !result.ok) setError(result.error);
  }

  async function reconnectTab(tab: Tab) {
    setError(undefined);
    await bridge.terminals.close(tab.terminalId);
    const result = await bridge.terminals.open(tab.target);
    if (!result.ok) {
      setTabs((current) =>
        current.map((item) => (item.terminalId === tab.terminalId ? { ...item, closed: true } : item))
      );
      setError(result.error);
      return;
    }
    setTabs((current) =>
      current.map((item) => (item.terminalId === tab.terminalId ? { ...result.terminal, target: tab.target } : item))
    );
    setActiveId(result.terminal.terminalId);
    setSecondaryId((current) => (current === tab.terminalId ? result.terminal.terminalId : current));
  }

  async function restoreWorkspace() {
    if (restoring || savedTargets.length === 0) return;
    setRestoring(true);
    setError(undefined);
    let failures = 0;
    // Sequential on purpose: opening many SSH handshakes at once can trigger
    // host rate limits and makes individual authentication prompts unusable.
    for (const target of savedTargets) {
      const result = await bridge.terminals.open(target);
      if (!accept(result, target)) failures += 1;
    }
    if (failures > 0) setError(`${failures} saved connection${failures === 1 ? "" : "s"} could not be restored.`);
    setRestoring(false);
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

  const secondaryTab = tabs.find((tab) => tab.terminalId === secondaryId && tab.terminalId !== activeId);
  const splitCandidate = tabs.find((tab) => tab.terminalId !== activeId && !tab.closed);
  const commandActions: CommandAction[] = [
    ...(tabs.length === 0 && savedTargets.length > 0
      ? [
          {
            id: "restore",
            label: "Restore workspace",
            detail: `${savedTargets.length} saved terminal${savedTargets.length === 1 ? "" : "s"}`,
            icon: "split" as const,
            run: () => void restoreWorkspace()
          }
        ]
      : []),
    {
      id: "local",
      label: "New local terminal",
      detail: "Open the default shell",
      icon: "terminal",
      keywords: "shell powershell bash zsh",
      run: () => void openLocal()
    },
    {
      id: "files",
      label: "Browse local files",
      detail: "Open the dual-pane file manager",
      icon: "files",
      run: () =>
        setOverlay({
          kind: "files",
          label: "This computer",
          target: { kind: "local" }
        })
    },
    {
      id: "vault",
      label: "Open Vault",
      detail: `${credentials.length} credential${credentials.length === 1 ? "" : "s"}`,
      icon: "key",
      run: () => setOverlay({ kind: "vault" })
    },
    {
      id: "history",
      label: "Open history & audit",
      detail: `${sessions.length} recent session${sessions.length === 1 ? "" : "s"}`,
      icon: "history",
      run: () => setOverlay({ kind: "history" })
    },
    {
      id: "settings",
      label: "Open settings",
      detail: "Connection, terminal and sharing",
      icon: "gear",
      run: () => setOverlay({ kind: "settings" })
    },
    ...visibleHosts.map((host) => ({
      id: `host-${host.id}`,
      label: `Connect to ${host.name}`,
      detail: `${host.username ? `${host.username}@` : ""}${host.address}`,
      icon: "host" as const,
      keywords: host.tags?.join(" "),
      run: () => void openHost(host)
    })),
    ...snippets.map((snippet) => ({
      id: `snippet-${snippet.id}`,
      label: `Insert ${snippet.name}`,
      detail: snippet.command,
      icon: "code" as const,
      keywords: "snippet command",
      run: () => sendSnippet(snippet)
    }))
  ];

  return (
    <div className="console">
      {paletteOpen && <CommandPalette actions={commandActions} onClose={() => setPaletteOpen(false)} />}
      <nav className="activity-rail" aria-label="Workspace navigation">
        <div className="activity-rail__brand" aria-label="Onshell">
          O
        </div>
        <button
          className={`activity-button${overlay.kind === "none" ? " activity-button--active" : ""}`}
          aria-label="Hosts"
          title="Hosts"
          onClick={() => setOverlay({ kind: "none" })}
        >
          <Icon name="host" />
        </button>
        <button
          className={`activity-button${overlay.kind === "files" ? " activity-button--active" : ""}`}
          aria-label="Open local files"
          title="Local files"
          onClick={() =>
            setOverlay({
              kind: "files",
              label: "This computer",
              target: { kind: "local" }
            })
          }
        >
          <Icon name="files" />
        </button>
        <button
          className="activity-button"
          aria-label="Focus snippets"
          title="Snippets"
          onClick={() => {
            setOverlay({ kind: "none" });
            requestAnimationFrame(() =>
              document.getElementById("snippets-heading")?.scrollIntoView({ block: "start" })
            );
          }}
        >
          <Icon name="code" />
        </button>
        <button
          className={`activity-button${overlay.kind === "vault" ? " activity-button--active" : ""}`}
          aria-label="Vault"
          title="Vault"
          onClick={() => setOverlay({ kind: "vault" })}
        >
          <Icon name="key" />
        </button>
        <button
          className={`activity-button${overlay.kind === "history" ? " activity-button--active" : ""}`}
          aria-label="History and audit"
          title="History and audit"
          onClick={() => setOverlay({ kind: "history" })}
        >
          <Icon name="history" />
        </button>
        <span className="activity-rail__spacer" />
        <button
          className={`activity-button${overlay.kind === "settings" ? " activity-button--active" : ""}`}
          aria-label="Settings"
          title="Settings"
          onClick={() => setOverlay({ kind: "settings" })}
        >
          <Icon name="gear" />
        </button>
        <div className="account-avatar" title={state.user?.email}>
          {(state.user?.name ?? state.user?.email ?? "U").slice(0, 1).toUpperCase()}
        </div>
      </nav>
      <aside className="sidebar">
        <div className="sidebar__head">
          <div>
            <div className="sidebar__eyebrow">Workspace</div>
            <div className="sidebar__account">{state.user?.name ?? state.user?.email ?? "Personal"}</div>
          </div>
          <button
            className="icon icon--framed"
            title="New local terminal"
            aria-label="New local terminal"
            onClick={() => void openLocal()}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>

        <div className="sidebar__search">
          <Icon name="search" size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search hosts"
            spellCheck={false}
            aria-label="Search hosts"
          />
          <button className="search-shortcut" onClick={() => setPaletteOpen(true)} title="Open command palette">
            <kbd>{state.platform === "darwin" ? "⌘" : "Ctrl"} K</kbd>
          </button>
        </div>

        <div className="sidebar__scroll">
          <div className="sidebar__section">
            <span>This computer</span>
            <span>{shells.length}</span>
          </div>
          {shells.length === 0 && <div className="host host__meta">No shell found on this machine.</div>}
          {shells.map((shell) => (
            <button
              key={shell.id}
              className="host host--simple"
              onClick={() => void openLocal(shell.id)}
              title={shell.command}
            >
              <span className="resource-icon resource-icon--local">
                <Icon name="terminal" size={15} />
              </span>
              <span className="host__copy">
                <span className="host__name">{shell.label}</span>
                <span className="host__meta">Local session</span>
              </span>
              <Icon name="chevron-right" size={14} className="host__chevron" />
            </button>
          ))}

          <div className="sidebar__section">
            <span>Hosts</span>
            <span>{visibleHosts.length}</span>
          </div>
          {loading && <div className="host host__meta">Loading…</div>}
          {!loading && visibleHosts.length === 0 && (
            <div className="host host__meta">{query ? "Nothing matches." : "No hosts saved yet."}</div>
          )}
          {visibleHosts.map((host) => (
            <div key={host.id} className="host host--row">
              <button className="host__open" onClick={() => void openHost(host)}>
                <span className="resource-icon">
                  <Icon name="host" size={15} />
                </span>
                <span className="host__copy">
                  <span className="host__name">{host.name}</span>
                  <span className="host__meta">
                    {host.username ? `${host.username}@` : ""}
                    {host.address}
                    {host.port && host.port !== 22 ? `:${host.port}` : ""}
                  </span>
                </span>
              </button>
              <div className="host__actions">
                <button
                  className="icon"
                  title={host.isFavorite ? "Unpin" : "Pin"}
                  onClick={() => void toggleFavorite(host)}
                >
                  <Icon name="star" size={15} fill={host.isFavorite ? "currentColor" : "none"} />
                </button>
                <button
                  className="icon"
                  title="Browse files"
                  onClick={() =>
                    setOverlay({
                      kind: "files",
                      label: host.name,
                      target: {
                        kind: state.connectionMode === "direct" ? "direct" : "relay",
                        hostId: host.id
                      }
                    })
                  }
                >
                  <Icon name="folder" size={15} />
                </button>
              </div>
            </div>
          ))}

          {snippets.length > 0 && (
            <>
              <div className="sidebar__section" id="snippets-heading">
                <span>Snippets</span>
                <span>{snippets.length}</span>
              </div>
              {snippets.map((snippet) => (
                <button
                  key={snippet.id}
                  className="host host--simple"
                  onClick={() => sendSnippet(snippet)}
                  title={snippet.command}
                >
                  <span className="resource-icon resource-icon--snippet">
                    <Icon name="code" size={15} />
                  </span>
                  <span className="host__copy">
                    <span className="host__name">{snippet.name}</span>
                    <span className="host__meta">Insert command</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="sidebar__foot">
          <span className="connection-state">
            <span className="connection-state__dot" />
            {state.connectionMode} connection
          </span>
          <button className="text-button" onClick={() => void bridge.auth.signOut()}>
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
              >
                <button
                  className="tab__select"
                  type="button"
                  onClick={() => {
                    setActiveId(tab.terminalId);
                    setOverlay({ kind: "none" });
                  }}
                >
                  <span className={`tab__status tab__status--${tab.mode}`} />
                  <span className="tab__title">
                    {tab.title}
                    {tab.closed ? " (ended)" : ""}
                  </span>
                </button>
                <button
                  className="tab__close"
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab.terminalId);
                  }}
                  aria-label={`Close ${tab.title}`}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
            <button
              className="tab tab--new"
              aria-label="New local terminal"
              title="New local terminal"
              onClick={() => void openLocal()}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
        )}

        {activeTab && overlay.kind === "none" && (
          <div className="terminal-toolbar" aria-label="Terminal actions">
            <div className="terminal-toolbar__session">
              <span className={`tab__status tab__status--${activeTab.mode}`} />
              <strong>{activeTab.title}</strong>
              <span>
                {activeTab.mode} session{activeTab.closed ? " · ended" : ""}
              </span>
            </div>
            <div className="terminal-toolbar__actions">
              <button
                className="toolbar-button"
                onClick={() => void reconnectTab(activeTab)}
                title="Reconnect terminal"
              >
                <Icon name="refresh" size={15} /> Reconnect
              </button>
              <button
                className="toolbar-button"
                onClick={() => void duplicateTab(activeTab)}
                title="Duplicate terminal"
              >
                <Icon name="plus" size={15} /> Duplicate
              </button>
              <button
                className={`toolbar-button${secondaryTab ? " toolbar-button--active" : ""}`}
                disabled={!secondaryTab && !splitCandidate}
                onClick={() => setSecondaryId(secondaryTab ? undefined : splitCandidate?.terminalId)}
                title={secondaryTab ? "Close split view" : "Split with another terminal"}
              >
                <Icon name="split" size={15} /> {secondaryTab ? "Unsplit" : "Split"}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="banner" role="alert">
            {error}
          </div>
        )}

        {relayOffer && (
          <div className="banner">
            <strong>{relayOffer.host.name}</strong> could not be reached directly from this machine —{" "}
            {relayOffer.reason} Connecting through the Onshell gateway will work, but that traffic passes through our
            servers rather than going straight to your host.
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

        <div className={`surface${secondaryTab && overlay.kind === "none" ? " surface--split" : ""}`}>
          {/* Terminals stay mounted underneath an overlay: unmounting one would
              throw away its scrollback, and a shell whose history vanishes when
              you glance at the file browser is not a terminal anyone wants. */}
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.terminalId}
              terminalId={tab.terminalId}
              appearance={state.appearance}
              visible={
                overlay.kind === "none" && (tab.terminalId === activeId || tab.terminalId === secondaryTab?.terminalId)
              }
              position={tab.terminalId === secondaryTab?.terminalId ? "secondary" : "primary"}
            />
          ))}

          {overlay.kind === "settings" && <Settings state={state} onClose={() => setOverlay({ kind: "none" })} />}

          {overlay.kind === "files" && (
            <Files remote={overlay.target} hostLabel={overlay.label} onClose={() => setOverlay({ kind: "none" })} />
          )}

          {overlay.kind === "vault" && (
            <VaultView credentials={credentials} hosts={hosts} onClose={() => setOverlay({ kind: "none" })} />
          )}

          {overlay.kind === "history" && (
            <HistoryView sessions={sessions} audit={audit} hosts={hosts} onClose={() => setOverlay({ kind: "none" })} />
          )}

          {overlay.kind === "none" && !activeTab && (
            <div className="empty">
              <div className="empty__icon">
                <Icon name="terminal" size={28} />
              </div>
              <div>
                <p className="empty__eyebrow">Onshell workspace</p>
                <h1>Ready when you are.</h1>
              </div>
              <p className="empty__lead">
                Start a local shell or choose a saved host. Direct sessions connect from this computer without routing
                terminal traffic through Onshell.
              </p>
              {(savedTargets.length > 0 || shells.length > 0 || visibleHosts[0]) && (
                <div className="empty__actions">
                  {savedTargets.length > 0 && (
                    <button
                      className="button button--primary"
                      disabled={restoring}
                      onClick={() => void restoreWorkspace()}
                    >
                      <Icon name="refresh" size={16} />{" "}
                      {restoring
                        ? "Restoring…"
                        : `Restore ${savedTargets.length} terminal${savedTargets.length === 1 ? "" : "s"}`}
                    </button>
                  )}
                  {shells[0] && (
                    <button
                      className={`button${savedTargets.length === 0 ? " button--primary" : ""}`}
                      onClick={() => void openLocal()}
                    >
                      <Icon name="terminal" size={16} /> Open {shells[0].label}
                    </button>
                  )}
                  {visibleHosts[0] && (
                    <button className="button" onClick={() => void openHost(visibleHosts[0])}>
                      Connect to {visibleHosts[0].name}
                    </button>
                  )}
                </div>
              )}
              <div className="shortcut-hint">
                <kbd>{state.platform === "darwin" ? "⌘" : "Ctrl"}</kbd>
                <kbd>Shift</kbd>
                <kbd>N</kbd>
                <span>New local terminal</span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
