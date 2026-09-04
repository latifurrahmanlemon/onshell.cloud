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
import type { AppState, FileSessionTargetRequest, UpdateStatus } from "../../shared/ipc.js";
import type { AuditLog, CredentialSummary, Host, RemoteSession, Snippet } from "@onshell/api-client";
import { TerminalPane } from "../terminal.js";
import { Files } from "./files.js";
import { Settings } from "./settings.js";
import { Help } from "./help.js";
import { Icon } from "../icons.js";
import { CommandPalette, type CommandAction } from "../command-palette.js";
import { HistoryView, HostsView, VaultView } from "./resource-view.js";
import { Tasks } from "./tasks.js";
import { beginWorkspaceHostDrag, Workspaces } from "./workspaces.js";

interface Props {
  state: AppState;
}

interface Tab extends TerminalOpened {
  closed?: boolean;
  target: TerminalTarget;
}

type Overlay =
  | { kind: "none" }
  | { kind: "hosts" }
  | { kind: "settings" }
  | { kind: "vault"; create?: boolean }
  | { kind: "history" }
  | { kind: "help" }
  | { kind: "tasks" }
  | { kind: "workspaces" }
  | { kind: "files"; target: FileSessionTargetRequest; label: string };

export function Console({ state }: Props) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [audit, setAudit] = useState<AuditLog[]>([]);
  const [tasks, setTasks] = useState<import("@onshell/api-client").TaskItem[]>([]);
  const [notifications, setNotifications] = useState<import("@onshell/api-client").AppNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [snippetQuery, setSnippetQuery] = useState("");
  const [snippetCreateOpen, setSnippetCreateOpen] = useState(false);
  const [snippetEditing, setSnippetEditing] = useState<Snippet>();
  const [snippetPosition, setSnippetPosition] = useState({ x: 0, y: 0 });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(286);
  const [hostEditor, setHostEditor] = useState<Host | "new">();
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  const [newTerminalQuery, setNewTerminalQuery] = useState("");

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
        setTasks(data.tasks);
        setNotifications(data.notifications);
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
    void bridge.updates.check().then(setUpdate);
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
  const visibleSnippets = snippets.filter((snippet) =>
    `${snippet.name} ${snippet.command}`.toLowerCase().includes(snippetQuery.trim().toLowerCase())
  );
  const newTerminalHosts = hosts.filter((host) =>
    `${host.name} ${host.address} ${host.username ?? ""}`.toLowerCase().includes(newTerminalQuery.trim().toLowerCase())
  );
  const newTerminalShells = shells.filter((shell) =>
    `${shell.label} ${shell.command}`.toLowerCase().includes(newTerminalQuery.trim().toLowerCase())
  );

  async function createSnippet(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const snippet = await bridge.console.createSnippet({
        name: String(data.get("name") ?? ""),
        command: String(data.get("command") ?? ""),
        scope: data.get("scope") === "team" ? "team" : "personal"
      });
      setSnippets((current) => [snippet, ...current]);
      setSnippetCreateOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the snippet.");
    }
  }

  async function updateSnippet(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snippetEditing) return;
    const data = new FormData(event.currentTarget);
    try {
      const snippet = await bridge.console.updateSnippet(snippetEditing.id, {
        name: String(data.get("name") ?? ""),
        command: String(data.get("command") ?? ""),
        scope: data.get("scope") === "team" ? "team" : "personal"
      });
      setSnippets((current) => current.map((item) => item.id === snippet.id ? snippet : item));
      setSnippetEditing(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the snippet.");
    }
  }

  async function saveHost(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      name: String(data.get("name") ?? ""), type: "ssh",
      address: String(data.get("address") ?? ""), port: Number(data.get("port") ?? 22),
      username: String(data.get("username") ?? "") || undefined,
      environment: String(data.get("environment") ?? "development"),
      tags: String(data.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean)
    };
    const credentialId = String(data.get("credentialId") ?? "");
    try {
      let savedHost: Host | undefined;
      if (hostEditor === "new") {
        const host = await bridge.console.createHost(input);
        savedHost = host;
        setHosts((current) => [...current, host]);
      } else if (hostEditor) {
        const host = await bridge.console.updateHost(hostEditor.id, input);
        savedHost = host;
        setHosts((current) => current.map((item) => item.id === host.id ? host : item));
      }
      if (savedHost) {
        const currentlyAttached = credentials.filter((item) => item.attachedHostIds.includes(savedHost!.id));
        await Promise.all(currentlyAttached.filter((item) => item.id !== credentialId).map((item) => bridge.console.updateCredential(item.id, { attachedHostIds: item.attachedHostIds.filter((id) => id !== savedHost!.id) })));
        const selected = credentials.find((item) => item.id === credentialId);
        if (selected && !selected.attachedHostIds.includes(savedHost.id)) await bridge.console.updateCredential(selected.id, { attachedHostIds: [...selected.attachedHostIds, savedHost.id] });
        if (currentlyAttached.length > 0 || selected) setCredentials(await bridge.console.load().then((result) => result.credentials));
      }
      setHostEditor(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the host.");
    }
  }

  async function deleteHost(host: Host) {
    if (!confirm(`Delete ${host.name}?`)) return;
    try {
      await bridge.console.deleteHost(host.id);
      setHosts((current) => current.filter((item) => item.id !== host.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the host.");
    }
  }

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

  async function openNamedWorkspace(hostIds: string[]) {
    setError(undefined);
    const opened: string[] = [];
    let failures = 0;
    for (const hostId of hostIds.slice(0, 4)) {
      const host = hosts.find((item) => item.id === hostId);
      if (!host) { failures += 1; continue; }
      const target: TerminalTarget = { kind: state.connectionMode === "direct" ? "direct" : "relay", hostId };
      const result = await bridge.terminals.open(target);
      if (result.ok) { accept(result, target); opened.push(result.terminal.terminalId); }
      else failures += 1;
    }
    if (opened.length > 1) setSecondaryId(opened.at(-2));
    if (failures) setError(`${failures} workspace host${failures === 1 ? "" : "s"} could not be opened.`);
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
    <div className={`console${sidebarOpen ? "" : " console--sidebar-hidden"}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      {paletteOpen && <CommandPalette actions={commandActions} onClose={() => setPaletteOpen(false)} />}
      <header className={`console-titlebar${state.platform === "darwin" ? " console-titlebar--mac" : ""}`}>
        <div className="console-titlebar__drag" />
        <div className="tabs" role="tablist" aria-label="Open terminals">
          {tabs.map((tab) => {
            const hostId = tab.target.kind === "local" ? undefined : tab.target.hostId;
            return (
              <div
                draggable={Boolean(hostId)}
                key={tab.terminalId}
                className={`tab${tab.terminalId === activeId && overlay.kind === "none" ? " tab--active" : ""}${hostId ? " tab--draggable" : ""}`}
                onDragStart={(event) => {
                  if (!hostId || (event.target as HTMLElement).closest(".tab__close")) {
                    event.preventDefault();
                    return;
                  }
                  beginWorkspaceHostDrag(event.dataTransfer, hostId);
                }}
                title={hostId ? "Drag this terminal into Workspaces" : undefined}
              >
                <button className="tab__select" type="button" onClick={() => { setActiveId(tab.terminalId); setOverlay({ kind: "none" }); }}>
                  <span className={`tab__status tab__status--${tab.mode}`} />
                  <span className="tab__title">{tab.title}{tab.closed ? " (ended)" : ""}</span>
                </button>
                <button className="tab__close" onClick={() => void closeTab(tab.terminalId)} aria-label={`Close ${tab.title}`}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            );
          })}
          {overlay.kind === "hosts" && <div className="tab tab--active"><button className="tab__select"><Icon name="host" size={14}/><span className="tab__title">Hosts</span></button><button className="tab__close" onClick={() => setOverlay({ kind: "none" })} aria-label="Close Hosts"><Icon name="close" size={13}/></button></div>}
          {overlay.kind === "tasks" && <div className="tab tab--active"><button className="tab__select"><Icon name="tasks" size={14}/><span className="tab__title">Tasks</span></button><button className="tab__close" onClick={() => setOverlay({ kind: "none" })} aria-label="Close Tasks"><Icon name="close" size={13}/></button></div>}
          {overlay.kind === "workspaces" && <div className="tab tab--active"><button className="tab__select"><Icon name="split" size={14}/><span className="tab__title">Workspaces</span></button><button className="tab__close" onClick={() => setOverlay({ kind: "none" })} aria-label="Close Workspaces"><Icon name="close" size={13}/></button></div>}
          {overlay.kind === "help" && <div className="tab tab--active"><button className="tab__select"><Icon name="help" size={14}/><span className="tab__title">Help</span></button><button className="tab__close" onClick={() => setOverlay({ kind: "none" })} aria-label="Close Help"><Icon name="close" size={13}/></button></div>}
          <button
            className="tab tab--new"
            aria-expanded={newTerminalOpen}
            aria-haspopup="menu"
            aria-label="Open a terminal"
            title="Open a terminal"
            onClick={() => setNewTerminalOpen((open) => !open)}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="console-titlebar__tools">
          <button className={`titlebar-tool${snippetsOpen ? " titlebar-tool--active" : ""}`} onClick={() => setSnippetsOpen((open) => !open)} aria-label="Snippets" data-tooltip="Snippets">
            <Icon name="code" size={15} />
          </button>
          <button className={`titlebar-tool${notificationsOpen ? " titlebar-tool--active" : ""}`} aria-label="Notifications" data-tooltip="Notifications" onClick={() => setNotificationsOpen((open) => !open)}>
            <Icon name="bell" size={15} />
            {(update?.available || notifications.some((item) => !item.read)) && <span className="notification-dot" />}
          </button>
          <span className="titlebar-connection" data-tooltip={`${state.connectionMode} connection`}>
            <span className="connection-state__dot" />
          </span>
        </div>
        {notificationsOpen && <div className="desktop-notifications" role="dialog" aria-label="Notifications"><header><strong>Notifications</strong><button className="icon" onClick={() => setNotificationsOpen(false)}><Icon name="close" size={13}/></button></header><div>{update?.available && <article className="is-unread"><strong>Onshell {update.latest} is available</strong><p>A new desktop release is ready to download.</p>{update.url && <button onClick={() => void bridge.openExternal(update.url!)}>Open release</button>}</article>}{notifications.map((item) => <article className={item.read ? "" : "is-unread"} key={item.id} onClick={() => { if (!item.read) { void bridge.console.markNotificationRead(item.id); setNotifications((current) => current.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry)); } }}><strong>{item.title}</strong><p>{item.message}</p>{item.actionUrl && <button onClick={() => void bridge.openExternal(item.actionUrl!)}>Learn more</button>}</article>)}{notifications.length === 0 && !update?.available && <p className="hint">You’re all caught up.</p>}</div></div>}
        {newTerminalOpen && (
          <div className="new-terminal-menu" role="menu" aria-label="Open a terminal">
            <div className="new-terminal-menu__search">
              <Icon name="search" size={14} />
              <input autoFocus value={newTerminalQuery} onChange={(event) => setNewTerminalQuery(event.target.value)} placeholder="Search hosts or shells" aria-label="Search hosts or shells" />
            </div>
            <div className="new-terminal-menu__list">
              {newTerminalShells.map((shell) => (
                <button key={shell.id} role="menuitem" onClick={() => { setNewTerminalOpen(false); setNewTerminalQuery(""); void openLocal(shell.id); }}>
                  <span className="resource-icon resource-icon--local"><Icon name="terminal" size={14} /></span>
                  <span><strong>{shell.label}</strong><small>This computer · Local shell</small></span>
                </button>
              ))}
              {newTerminalHosts.map((host) => (
                <button key={host.id} role="menuitem" onClick={() => { setNewTerminalOpen(false); setNewTerminalQuery(""); void openHost(host); }}>
                  <span className="resource-icon"><Icon name="host" size={14} /></span>
                  <span><strong>{host.name}</strong><small>{host.username ? `${host.username}@` : ""}{host.address}{host.port !== 22 ? `:${host.port}` : ""}</small></span>
                </button>
              ))}
              {newTerminalShells.length === 0 && newTerminalHosts.length === 0 && <p>No matching hosts or shells.</p>}
            </div>
          </div>
        )}
      </header>
      <nav className="activity-rail" aria-label="Workspace navigation">
        <button
          className="activity-rail__brand"
          aria-label={sidebarOpen ? "Hide hosts panel" : "Show hosts panel"}
          aria-pressed={sidebarOpen}
          data-tooltip={sidebarOpen ? "Hide host panel" : "Show host panel"}
          onClick={() => setSidebarOpen((open) => !open)}
          type="button"
        >
          O
        </button>
        <button
          className={`activity-button${overlay.kind === "hosts" ? " activity-button--active" : ""}`}
          aria-label="Hosts"
          title="Hosts"
          onClick={() => setOverlay({ kind: "hosts" })}
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
        <button className={`activity-button${overlay.kind === "tasks" ? " activity-button--active" : ""}`} aria-label="Tasks" data-tooltip="Tasks" onClick={() => setOverlay({ kind: "tasks" })}><Icon name="tasks" /></button>
        <button className={`activity-button${overlay.kind === "workspaces" ? " activity-button--active" : ""}`} aria-label="Workspaces" data-tooltip="Workspaces" onClick={() => setOverlay({ kind: "workspaces" })}><Icon name="split" /></button>
        <span className="activity-rail__spacer" />
        <button className={`activity-button${overlay.kind === "help" ? " activity-button--active" : ""}`} aria-label="Help and support" data-tooltip="Help" onClick={() => setOverlay({ kind: "help" })}><Icon name="help" /></button>
        <button
          className={`activity-button${overlay.kind === "settings" ? " activity-button--active" : ""}`}
          aria-label="Settings"
          title="Settings"
          onClick={() => setOverlay({ kind: "settings" })}
        >
          <Icon name="gear" />
        </button>
        <div className="account-menu">
          <button className="account-avatar" aria-expanded={profileOpen} aria-label="Open profile menu" onClick={() => setProfileOpen((open) => !open)} data-tooltip="Profile">
            {state.user?.avatarUrl ? <img alt="" src={state.user.avatarUrl} /> : (state.user?.name ?? state.user?.email ?? "U").slice(0, 1).toUpperCase()}
          </button>
          {profileOpen && (
            <div className="account-popover">
              <strong>{state.user?.name ?? "Onshell user"}</strong>
              <span>{state.user?.email}</span>
              <button onClick={() => void bridge.auth.signOut()}><Icon name="logout" size={14} /> Sign out</button>
            </div>
          )}
        </div>
      </nav>
      <aside className="sidebar">
        <div className="sidebar__head">
          <div>
            <div className="sidebar__eyebrow">Workspace</div>
            <div className="sidebar__account">{state.user?.name ?? state.user?.email ?? "Personal"}</div>
          </div>
          <div className="sidebar__head-actions">
            <button className="icon icon--framed" title="Open local terminal" aria-label="Open local terminal" onClick={() => void openLocal()}>
              <Icon name="terminal" size={15} />
            </button>
            <button className="icon icon--framed" title="Add host" aria-label="Add host" onClick={() => setHostEditor("new")}>
              <Icon name="plus" size={16} />
            </button>
          </div>
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
            <div
              draggable
              key={host.id}
              className="host host--row host--draggable"
              onDragStart={(event) => {
                if ((event.target as HTMLElement).closest(".host__actions")) {
                  event.preventDefault();
                  return;
                }
                beginWorkspaceHostDrag(event.dataTransfer, host.id);
              }}
              title="Drag this host into Workspaces"
            >
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
                {!host.isLocal && !host.isAgent && (
                  <button className="icon" title="Edit host" onClick={() => setHostEditor(host)}>
                    <Icon name="gear" size={14} />
                  </button>
                )}
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
                {!host.isLocal && !host.isAgent && (
                  <button className="icon icon--danger" title="Delete host" onClick={() => void deleteHost(host)}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}

        </div>

        <div className="sidebar__foot">
          <span className="connection-state">
            <span className="connection-state__dot" />
            {state.connectionMode} connection
          </span>
        </div>
        <div
          aria-label="Resize hosts panel"
          aria-orientation="vertical"
          className="sidebar-resizer"
          role="separator"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") setSidebarWidth((width) => Math.max(230, width - 16));
            if (event.key === "ArrowRight") setSidebarWidth((width) => Math.min(480, width + 16));
          }}
          onPointerDown={(event) => {
            const startX = event.clientX;
            const startWidth = sidebarWidth;
            const move = (moveEvent: PointerEvent) => setSidebarWidth(Math.min(480, Math.max(230, startWidth + moveEvent.clientX - startX)));
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      </aside>

      <main className="workspace">
        {snippetsOpen && (
          <div className="floating-snippets" role="dialog" aria-label="Snippets" style={{ transform: `translate(${snippetPosition.x}px, ${snippetPosition.y}px)` }}>
            <div className="floating-snippets__head" onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("button, input")) return;
              const pointer = { x: event.clientX, y: event.clientY };
              const origin = snippetPosition;
              const move = (moveEvent: PointerEvent) => setSnippetPosition({ x: origin.x + moveEvent.clientX - pointer.x, y: origin.y + moveEvent.clientY - pointer.y });
              const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
              window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
            }}>
              <strong>Snippets</strong>
              <div><button className="icon" onClick={() => setSnippetCreateOpen(true)} aria-label="Create snippet" data-tooltip="New snippet"><Icon name="plus" size={13} /></button><button className="icon" onClick={() => setSnippetsOpen(false)} aria-label="Hide snippets"><Icon name="close" size={13} /></button></div>
            </div>
            <div className="floating-snippets__search"><Icon name="search" size={14} /><input value={snippetQuery} onChange={(event) => setSnippetQuery(event.target.value)} placeholder="Search snippets" aria-label="Search snippets" /></div>
            <div className="floating-snippets__list">
              {visibleSnippets.map((snippet) => (
                <article key={snippet.id}>
                  <div><strong>{snippet.name}</strong><code className="selectable">{snippet.command}</code></div>
                  <div>
                    <button className="icon icon--framed" aria-label={`Copy ${snippet.name}`} title="Copy" onClick={() => void navigator.clipboard.writeText(snippet.command)}><Icon name="copy" size={13}/></button>
                    <button className="icon icon--framed" aria-label={`Paste ${snippet.name}`} title="Paste" onClick={() => sendSnippet(snippet)}><Icon name="code" size={13}/></button>
                    <button className="icon icon--framed" aria-label={`Edit ${snippet.name}`} title="Edit" onClick={() => setSnippetEditing(snippet)}><Icon name="gear" size={13}/></button>
                    <button className="icon icon--framed icon--accent" aria-label={`Run ${snippet.name}`} title="Run" onClick={() => { if (!activeId) return setError("Open a terminal first."); bridge.terminals.write(activeId, `${snippet.command}\n`); }}><Icon name="play" size={13}/></button>
                  </div>
                </article>
              ))}
              {visibleSnippets.length === 0 && <p className="hint">No matching snippets.</p>}
            </div>
          </div>
        )}
        {snippetCreateOpen && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSnippetCreateOpen(false); }}>
            <form className="snippet-modal" onSubmit={(event) => void createSnippet(event)}>
              <header><div><span className="snippet-emoji" aria-hidden="true">⌘</span><div><strong>New snippet</strong><p>Save a command for quick paste or run.</p></div></div><button className="icon" type="button" onClick={() => setSnippetCreateOpen(false)} aria-label="Close"><Icon name="close" size={14} /></button></header>
              <label>Name<input name="name" required minLength={2} autoFocus placeholder="Restart service" /></label>
              <label>Command<textarea name="command" required rows={4} placeholder="sudo systemctl restart…" /></label>
              <label>Visibility<select name="scope"><option value="personal">Only me</option><option value="team">Workspace team</option></select></label>
              <footer><button className="button button--ghost" type="button" onClick={() => setSnippetCreateOpen(false)}>Cancel</button><button className="button button--primary" type="submit">Create snippet</button></footer>
            </form>
          </div>
        )}
        {snippetEditing && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSnippetEditing(undefined); }}>
            <form className="snippet-modal" onSubmit={(event) => void updateSnippet(event)}>
              <header><div><span className="snippet-emoji"><Icon name="code" size={16}/></span><div><strong>Edit snippet</strong><p>Update the command or its visibility.</p></div></div><button className="icon" type="button" onClick={() => setSnippetEditing(undefined)} aria-label="Close"><Icon name="close" size={14}/></button></header>
              <label>Name<input name="name" required minLength={2} defaultValue={snippetEditing.name}/></label>
              <label>Command<textarea name="command" required rows={4} defaultValue={snippetEditing.command}/></label>
              <label>Visibility<select name="scope" defaultValue={snippetEditing.scope}><option value="personal">Only me</option><option value="team">Workspace team</option></select></label>
              <footer><button className="button button--ghost" type="button" onClick={() => setSnippetEditing(undefined)}>Cancel</button><button className="button button--primary" type="submit">Save changes</button></footer>
            </form>
          </div>
        )}
        {hostEditor && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHostEditor(undefined); }}>
            <form className="snippet-modal" onSubmit={(event) => void saveHost(event)}>
              <header><div><span className="snippet-emoji" aria-hidden="true"><Icon name="host" size={17} /></span><div><strong>{hostEditor === "new" ? "Add host" : "Edit host"}</strong><p>Changes sync with the web workspace immediately.</p></div></div><button className="icon" type="button" onClick={() => setHostEditor(undefined)} aria-label="Close"><Icon name="close" size={14} /></button></header>
              <label>Name<input name="name" required minLength={2} defaultValue={hostEditor === "new" ? "" : hostEditor.name} /></label>
              <div className="modal-fields"><label>Address<input name="address" required defaultValue={hostEditor === "new" ? "" : hostEditor.address} /></label><label>Port<input name="port" required type="number" min={1} max={65535} defaultValue={hostEditor === "new" ? 22 : hostEditor.port} /></label></div>
              <label>Username<input name="username" defaultValue={hostEditor === "new" ? "" : hostEditor.username} /></label>
              <label>Environment<select name="environment" defaultValue={hostEditor === "new" ? "development" : hostEditor.environment}><option value="production">Production</option><option value="staging">Staging</option><option value="development">Development</option></select></label>
              <div className="host-auth-row"><label>Authentication<select name="credentialId" defaultValue={hostEditor === "new" ? "" : credentials.find((item) => item.attachedHostIds.includes(hostEditor.id))?.id ?? ""}><option value="">No credential</option>{credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name} · {credential.kind.replace("_", " ")}</option>)}</select></label><button className="button button--ghost" type="button" onClick={() => { setHostEditor(undefined); setOverlay({ kind: "vault", create: true }); }}>Create in Vault</button></div>
              <label>Tags<input name="tags" defaultValue={hostEditor === "new" ? "" : hostEditor.tags.join(", ")} placeholder="web, customer-a" /></label>
              <footer><button className="button button--ghost" type="button" onClick={() => setHostEditor(undefined)}>Cancel</button><button className="button button--primary" type="submit">Save host</button></footer>
            </form>
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
              appearance={{ ...state.appearance, terminalTheme: tab.target.kind !== "local" && tab.target.hostId ? state.appearance.hostThemes[tab.target.hostId] ?? state.appearance.terminalTheme : state.appearance.terminalTheme }}
              visible={
                overlay.kind === "none" && (tab.terminalId === activeId || tab.terminalId === secondaryTab?.terminalId)
              }
              position={tab.terminalId === secondaryTab?.terminalId ? "secondary" : "primary"}
            />
          ))}

          {overlay.kind === "settings" && <Settings state={state} hosts={hosts} onClose={() => setOverlay({ kind: "none" })} />}

          {overlay.kind === "files" && (
            <Files remote={overlay.target} hostLabel={overlay.label} hosts={hosts} connectionMode={state.connectionMode} onClose={() => setOverlay({ kind: "none" })} />
          )}

          {overlay.kind === "vault" && (
            <VaultView credentials={credentials} hosts={hosts} openCreateOnMount={overlay.create} onClose={() => setOverlay({ kind: "none" })} />
          )}
          {overlay.kind === "hosts" && <HostsView hosts={hosts} onClose={() => setOverlay({ kind: "none" })} onOpen={(host) => void openHost(host)} onEdit={setHostEditor} />}

          {overlay.kind === "history" && (
            <HistoryView sessions={sessions} audit={audit} hosts={hosts} onClose={() => setOverlay({ kind: "none" })} />
          )}
          {overlay.kind === "tasks" && <Tasks initial={tasks} />}
          {overlay.kind === "workspaces" && <Workspaces hosts={hosts} currentHostIds={tabs.map((tab) => tab.target.kind === "local" ? undefined : tab.target.hostId).filter((id): id is string => Boolean(id))} onOpen={(ids) => void openNamedWorkspace(ids)} />}
          {overlay.kind === "help" && <Help version={state.version} onClose={() => setOverlay({ kind: "none" })} />}

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
