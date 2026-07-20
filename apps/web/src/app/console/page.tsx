"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeftRight,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderLock,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Server,
  Settings,
  SquareTerminal,
  Sun,
  Users,
  X
} from "lucide-react";
import type { AuditLog, CredentialSummary, Host, Organization, RemoteSession, Snippet, ThemePreference, User } from "@onshell/shared";
import { cx } from "@onshell/ui";
import { ApiError, consoleApi, gatewayBaseUrl, sessionWebsocketUrl } from "./api";
import type { PendingInvitation, TeamMember } from "./api";
import { AuditView, EmptyState, HostsView, SettingsView, SnippetsView, TeamView, VaultView } from "./panels";
import type { TerminalStatus } from "./terminal";
import { OnshellMark } from "../brand";
import { useTheme } from "../theme";
import "./console.css";

const SIDEBAR_COLLAPSE_KEY = "onshell-sidebar-collapsed";

const XtermTerminal = dynamic(() => import("./terminal"), { ssr: false });

type ViewKey = "overview" | "hosts" | "terminal" | "sftp" | "vault" | "snippets" | "team" | "audit" | "settings";

interface TerminalTab {
  key: string;
  sessionId: string;
  hostName: string;
  websocketUrl: string;
  status: TerminalStatus;
}

interface SftpEntry {
  name: string;
  directory: boolean;
  size?: number;
}

interface Toast {
  message: string;
  kind: "success" | "error";
}

const navItems: Array<{ key: ViewKey; label: string; icon: typeof Server }> = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "hosts", label: "Hosts", icon: Server },
  { key: "terminal", label: "Terminal", icon: SquareTerminal },
  { key: "sftp", label: "Files", icon: FolderLock },
  { key: "vault", label: "Vault", icon: KeyRound },
  { key: "snippets", label: "Snippets", icon: Braces },
  { key: "team", label: "Team", icon: Users },
  { key: "audit", label: "Audit", icon: ScrollText },
  { key: "settings", label: "Settings", icon: Settings }
];

function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function ConsolePage() {
  const reduceMotion = useReducedMotion();
  const [identity, setIdentity] = useState<{ user: User; organization?: Organization } | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [view, setView] = useState<ViewKey>("overview");
  const { mode, accent, setMode, setAccent } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const [hosts, setHosts] = useState<Host[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [audit, setAudit] = useState<AuditLog[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [injected, setInjected] = useState<{ id: number; command: string } | null>(null);
  const injectedCounter = useRef(0);

  const [sftp, setSftp] = useState<{
    gatewaySessionId: string;
    hostName: string;
    path: string;
    entries: SftpEntry[];
    busy: boolean;
    error: string | null;
  } | null>(null);

  const notify = useCallback((message: string, kind: "success" | "error" = "success") => {
    setToast({ message, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Restore the sidebar collapsed preference (per device).
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  // Persist theme changes to the account (debounced) so they follow the user
  // across devices. The local apply is instant; the API call is best-effort.
  const themeSaveTimer = useRef<number | null>(null);
  const persistTheme = useCallback((pref: ThemePreference) => {
    if (themeSaveTimer.current) window.clearTimeout(themeSaveTimer.current);
    themeSaveTimer.current = window.setTimeout(() => {
      void consoleApi.updateProfile({ themePreference: pref }).catch(() => undefined);
    }, 500);
  }, []);

  const handleMode = useCallback(
    (next: "light" | "dark") => {
      setMode(next);
      persistTheme({ mode: next, accent });
    },
    [setMode, persistTheme, accent]
  );

  const handleAccent = useCallback(
    (next: string) => {
      setAccent(next);
      persistTheme({ mode, accent: next });
    },
    [setAccent, persistTheme, mode]
  );

  // Close the profile menu on outside click or Escape.
  useEffect(() => {
    if (!profileOpen) return;
    const onDocClick = () => setProfileOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileOpen(false);
    };
    const raf = window.setTimeout(() => document.addEventListener("click", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(raf);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [profileOpen]);

  /* auth + data */
  const refreshAll = useCallback(async () => {
    setLoadError(null);
    const results = await Promise.allSettled([
      consoleApi.hosts(),
      consoleApi.credentials(),
      consoleApi.sessions(),
      consoleApi.snippets(),
      consoleApi.audit(80),
      consoleApi.organization(),
      consoleApi.invitations().catch(() => [] as PendingInvitation[])
    ]);
    const [hostsR, credentialsR, sessionsR, snippetsR, auditR, orgR, invitationsR] = results;
    if (hostsR.status === "fulfilled") setHosts(hostsR.value);
    if (credentialsR.status === "fulfilled") setCredentials(credentialsR.value);
    if (sessionsR.status === "fulfilled") setSessions(sessionsR.value);
    if (snippetsR.status === "fulfilled") setSnippets(snippetsR.value);
    if (auditR.status === "fulfilled") setAudit(auditR.value);
    if (invitationsR.status === "fulfilled") setInvitations(invitationsR.value);
    if (orgR.status === "fulfilled") {
      const payload = orgR.value as Record<string, unknown>;
      const nested = payload.organization as Record<string, unknown> | undefined;
      const rawMembers = Array.isArray(payload.members)
        ? payload.members
        : nested && Array.isArray(nested.members)
          ? nested.members
          : [];
      setMembers(rawMembers as TeamMember[]);
    }
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length === results.length) {
      setLoadError("The API is not reachable. Start it with `yarn dev` and refresh.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    consoleApi
      .me()
      .then(async (payload) => {
        if (!active) return;
        const user = (payload as { user?: User }).user ?? (payload as unknown as User);
        const organization = (payload as { organization?: Organization }).organization;
        setIdentity({ user, organization });
        // Account theme wins on login, syncing this device to the saved choice.
        const pref = user.themePreference;
        if (pref?.mode) setMode(pref.mode);
        if (pref?.accent) setAccent(pref.accent);
        await refreshAll();
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          window.location.href = "/login";
          return;
        }
        setAuthFailed(true);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshAll]);

  /* SFTP */
  const browseSftp = useCallback(async (gatewaySessionId: string, path: string, hostName: string) => {
    setSftp((current) => (current ? { ...current, busy: true, error: null } : current));
    try {
      const response = await fetch(
        `${gatewayBaseUrl}/sessions/${gatewaySessionId}/sftp/list?path=${encodeURIComponent(path)}`
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("Could not list this directory.");
      const rawEntries: unknown[] = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).entries)
          ? ((payload as Record<string, unknown>).entries as unknown[])
          : [];
      const entries: SftpEntry[] = rawEntries.map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          name: String(item.name ?? item.filename ?? "?"),
          directory:
            item.directory === true || item.isDirectory === true || item.type === "directory" || item.type === "d",
          size: typeof item.size === "number" ? item.size : undefined
        };
      });
      entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      setSftp({ gatewaySessionId, hostName, path, entries, busy: false, error: null });
    } catch (error) {
      setSftp((current) =>
        current
          ? { ...current, busy: false, error: error instanceof Error ? error.message : "SFTP listing failed." }
          : current
      );
    }
  }, []);

  /* sessions */
  const launchSession = useCallback(
    async (host: Host, protocol: "ssh" | "sftp" | "rdp") => {
      if (protocol === "rdp") {
        notify("RDP viewer ships in the next phase — the gateway bridge is ready, the browser client is not.", "error");
        return;
      }
      try {
        const { session, websocketUrl } = await consoleApi.openSession({ hostId: host.id, protocol });
        if (protocol === "ssh") {
          const tab: TerminalTab = {
            key: `${session.id}-${Date.now()}`,
            sessionId: session.id,
            hostName: host.name,
            websocketUrl: sessionWebsocketUrl(session, websocketUrl),
            status: "connecting"
          };
          setTabs((current) => [...current, tab]);
          setActiveTab(tab.key);
          setView("terminal");
        } else {
          const gatewaySessionId = session.gatewaySessionId ?? session.id;
          setSftp({ gatewaySessionId, hostName: host.name, path: ".", entries: [], busy: true, error: null });
          setView("sftp");
          await browseSftp(gatewaySessionId, ".", host.name);
        }
        void consoleApi.sessions().then(setSessions).catch(() => undefined);
      } catch (error) {
        notify(error instanceof Error ? error.message : "Could not open the session.", "error");
      }
    },
    [notify, browseSftp]
  );

  const closeTab = useCallback((tab: TerminalTab) => {
    setTabs((current) => {
      const remaining = current.filter((item) => item.key !== tab.key);
      setActiveTab((active) => (active === tab.key ? (remaining.at(-1)?.key ?? null) : active));
      return remaining;
    });
    void consoleApi.closeSession(tab.sessionId).catch(() => undefined);
  }, []);

  const runSnippet = useCallback(
    (command: string) => {
      if (!activeTab) {
        notify("Open a terminal first, then run the snippet.", "error");
        return;
      }
      injectedCounter.current += 1;
      setInjected({ id: injectedCounter.current, command });
      setView("terminal");
    },
    [activeTab, notify]
  );

  // Open a terminal to the local machine over SSH (127.0.0.1), reusing a
  // "Localhost" host or creating one on first use — no manual host setup needed.
  const connectLocalhost = useCallback(async () => {
    try {
      let host = hosts.find(
        (item) => item.type === "ssh" && (item.address === "127.0.0.1" || item.address === "localhost")
      );
      if (!host) {
        await consoleApi.createHost({
          name: "Localhost",
          type: "ssh",
          address: "127.0.0.1",
          port: 22,
          environment: "development",
          tags: ["local"]
        });
        const fresh = await consoleApi.hosts();
        setHosts(fresh);
        host = fresh.find((item) => item.address === "127.0.0.1" || item.address === "localhost");
      }
      if (host) {
        await launchSession(host, "ssh");
      } else {
        notify("Could not prepare a localhost host.", "error");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not connect to localhost.", "error");
    }
  }, [hosts, launchSession, notify]);

  async function deleteHost(host: Host) {
    if (!window.confirm(`Delete host "${host.name}"?`)) return;
    try {
      await consoleApi.deleteHost(host.id);
      notify("Host deleted.", "success");
      setHosts(await consoleApi.hosts());
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not delete host.", "error");
    }
  }

  async function logout() {
    try {
      await consoleApi.logout();
    } finally {
      window.location.href = "/login";
    }
  }

  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    members.forEach((member) => map.set(member.id, member.name));
    if (identity) map.set(identity.user.id, identity.user.name);
    return map;
  }, [members, identity]);

  const activeSessions = useMemo(() => sessions.filter((session) => session.status === "active"), [sessions]);

  if (!identity) {
    return (
      <main className="console-loading console-page">
        {authFailed ? (
          <>
            <AlertTriangle size={26} />
            <p>
              Could not reach the API at <code>{process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}</code>.
              Start the stack with <code>yarn dev</code>, then reload.
            </p>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="console-spinner" />
            <p>Loading your workspace…</p>
          </>
        )}
      </main>
    );
  }

  const role = identity.user.role;

  return (
    <div className={cx("app-shell console-page", collapsed && "is-collapsed")}>
      <aside className="sidebar">
        <div className="brand-row">
          <button className="brand-link" onClick={() => setView("overview")} type="button" title="Onshell.cloud">
            <OnshellMark size={34} />
            <span className="brand-copy">
              <span className="brand-name">Onshell.cloud</span>
              <span className="brand-domain">{identity.organization?.name ?? "Workspace"}</span>
            </span>
          </button>
        </div>
        <nav aria-label="Console" className="nav-list">
          {navItems.map((item) => (
            <button
              className={cx("nav-item", view === item.key && "is-active")}
              key={item.key}
              onClick={() => setView(item.key)}
              title={collapsed ? item.label : undefined}
              type="button"
            >
              <item.icon size={18} />
              <span className="nav-label">{item.label}</span>
              {item.key === "terminal" && tabs.length > 0 && <span className="nav-badge">{tabs.length}</span>}
              {item.key === "hosts" && hosts.length > 0 && <span className="nav-badge">{hosts.length}</span>}
            </button>
          ))}
        </nav>
        <button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="sidebar-collapse"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : undefined}
          type="button"
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          <span className="nav-label">Collapse</span>
        </button>
      </aside>

      <main className="workspace">
        <div className="console-topright">
          <button
            aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="console-topright-btn"
            data-tooltip={mode === "dark" ? "Light mode" : "Dark mode"}
            onClick={() => handleMode(mode === "dark" ? "light" : "dark")}
            type="button"
          >
            {mode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>

          <div className="profile-menu">
            <button
              aria-expanded={profileOpen}
              aria-haspopup="menu"
              className={cx("profile-trigger", profileOpen && "is-open")}
              onClick={(event) => {
                event.stopPropagation();
                setProfileOpen((open) => !open);
              }}
              type="button"
            >
              <span className="profile-avatar">
                {identity.user.avatarUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img alt="" src={identity.user.avatarUrl} />
                ) : (
                  <span>{avatarInitials(identity.user.name)}</span>
                )}
              </span>
              <span className="profile-name">{identity.user.name.split(" ")[0]}</span>
              <ChevronDown className="profile-chevron" size={15} />
            </button>
            <AnimatePresence>
              {profileOpen && (
                <motion.div
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  className="profile-dropdown"
                  exit={reduceMotion ? undefined : { opacity: 0, y: -6, scale: 0.98 }}
                  initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                  onClick={(event) => event.stopPropagation()}
                  role="menu"
                  transition={{ duration: 0.14, ease: "easeOut" }}
                >
                  <div className="profile-head">
                    <span className="profile-avatar lg">
                      {identity.user.avatarUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img alt="" src={identity.user.avatarUrl} />
                      ) : (
                        <span>{avatarInitials(identity.user.name)}</span>
                      )}
                    </span>
                    <div className="profile-head-meta">
                      <strong>{identity.user.name}</strong>
                      <span>{identity.user.email}</span>
                      <span className="profile-role">{identity.user.role}</span>
                    </div>
                  </div>
                  <div className="profile-actions">
                    <button
                      onClick={() => {
                        setView("settings");
                        setProfileOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Settings size={15} />
                      Settings
                    </button>
                    {identity.user.isPlatformAdmin && (
                      <button
                        onClick={() => {
                          window.location.href = "/admin";
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <ArrowLeftRight size={15} />
                        Admin panel
                      </button>
                    )}
                    <div className="profile-divider" />
                    <button
                      className="danger"
                      onClick={() => {
                        setProfileOpen(false);
                        void logout();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <LogOut size={15} />
                      Log out
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="view-container"
            exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            key={view}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {view === "overview" && (
              <>
                <div className="topbar">
                  <div>
                    <h1>Welcome back, {identity.user.name.split(" ")[0]}</h1>
                    <p>Everything your team runs, in one audited workspace.</p>
                  </div>
                </div>
                {loadError && <div className="error-banner">{loadError}</div>}
                <div className="metrics-grid">
                  <Metric color="green" hint="registered" icon={Server} label="Hosts" value={hosts.length} />
                  <Metric color="cyan" hint="live now" icon={SquareTerminal} label="Active Sessions" value={activeSessions.length} />
                  <Metric color="amber" hint="encrypted" icon={KeyRound} label="Vault Items" value={credentials.length} />
                  <Metric color="rose" hint="recent" icon={ScrollText} label="Audit Events" value={audit.length} />
                </div>
                <div className="content-grid">
                  <div className="main-column">
                    <section className="panel">
                      <div className="panel-header tight">
                        <h2>Recent Sessions</h2>
                      </div>
                      {sessions.length === 0 ? (
                        <EmptyState
                          hint="Launch a host to start your first session."
                          icon={<SquareTerminal size={22} />}
                          title="No sessions yet"
                        />
                      ) : (
                        <div className="session-list">
                          {sessions.slice(0, 6).map((session) => (
                            <div className="session-row" key={session.id}>
                              <SquareTerminal size={15} />
                              <div>
                                <strong>
                                  {hosts.find((host) => host.id === session.hostId)?.name ?? session.hostId.slice(0, 8)}
                                </strong>
                                <small>
                                  {session.protocol.toUpperCase()} · {new Date(session.startedAt).toLocaleString()}
                                </small>
                              </div>
                              <span className={cx("session-state", session.status === "pending" && "pending")}>
                                {session.status}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  </div>
                  <div className="side-column">
                    <section className="panel">
                      <div className="panel-header tight">
                        <h2>Latest Activity</h2>
                      </div>
                      <div className="audit-list">
                        {audit.slice(0, 5).map((log) => (
                          <div className="audit-row" key={log.id}>
                            <span>
                              {new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                            <div>
                              <strong>{log.action.replaceAll(".", " · ")}</strong>
                              <small>{memberNames.get(log.actorId) ?? "system"}</small>
                            </div>
                          </div>
                        ))}
                        {audit.length === 0 && <EmptyState icon={<ScrollText size={20} />} title="No activity yet" />}
                      </div>
                    </section>
                  </div>
                </div>
              </>
            )}

            {view === "hosts" && (
              <HostsView
                error={loadError}
                hosts={hosts}
                loading={loading}
                notify={notify}
                onCreated={() => void consoleApi.hosts().then(setHosts)}
                onDelete={deleteHost}
                onLaunch={launchSession}
                onRefresh={() => void consoleApi.hosts().then(setHosts).catch(() => notify("Refresh failed.", "error"))}
                role={role}
              />
            )}

            {view === "terminal" && (
              <section className="panel">
                <div className="panel-header tight">
                  <div>
                    <h2>Terminal</h2>
                    <p>Live SSH over the Onshell gateway — every session is audited.</p>
                  </div>
                </div>
                {tabs.length === 0 ? (
                  <div className="terminal-empty">
                    <SquareTerminal size={26} />
                    <strong>No open terminals</strong>
                    <span>Open a localhost shell, or pick a host to start an audited SSH session in this tab.</span>
                    <div className="inline-form" style={{ justifyContent: "center" }}>
                      <button className="primary-button" onClick={() => void connectLocalhost()} type="button">
                        <Monitor size={15} />
                        Localhost shell
                      </button>
                      <button className="secondary-button" onClick={() => setView("hosts")} type="button">
                        Browse Hosts
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="terminal-tabs" role="tablist">
                      {tabs.map((tab) => (
                        <div
                          aria-selected={activeTab === tab.key}
                          className={cx("terminal-tab", activeTab === tab.key && "is-active")}
                          data-status={tab.status}
                          key={tab.key}
                          onClick={() => setActiveTab(tab.key)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") setActiveTab(tab.key);
                          }}
                          role="tab"
                          tabIndex={0}
                        >
                          <span aria-hidden="true" className="tab-dot" />
                          {tab.hostName}
                          <button
                            aria-label={`Close ${tab.hostName}`}
                            className="tab-close"
                            onClick={(event) => {
                              event.stopPropagation();
                              closeTab(tab);
                            }}
                            type="button"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="terminal-stage">
                      {tabs.map((tab) => (
                        <div key={tab.key} style={{ display: activeTab === tab.key ? "block" : "none" }}>
                          <XtermTerminal
                            injectedCommand={activeTab === tab.key ? injected : null}
                            onStatusChange={(status) =>
                              setTabs((current) =>
                                current.map((item) => (item.key === tab.key ? { ...item, status } : item))
                              )
                            }
                            websocketUrl={tab.websocketUrl}
                          />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </section>
            )}

            {view === "sftp" && (
              <section className="panel">
                <div className="panel-header tight">
                  <div>
                    <h2>Files</h2>
                    <p>SFTP browser{sftp ? ` — ${sftp.hostName}` : ""}. Upload/download ship in the next phase.</p>
                  </div>
                </div>
                {!sftp ? (
                  <div className="terminal-empty">
                    <FolderLock size={26} />
                    <strong>No SFTP session</strong>
                    <span>Open one from an SSH host.</span>
                    <div className="inline-form" style={{ justifyContent: "center" }}>
                      {hosts
                        .filter((host) => host.type === "ssh")
                        .slice(0, 4)
                        .map((host) => (
                          <button
                            className="secondary-button"
                            key={host.id}
                            onClick={() => launchSession(host, "sftp")}
                            type="button"
                          >
                            <FolderLock size={14} />
                            {host.name}
                          </button>
                        ))}
                      {hosts.filter((host) => host.type === "ssh").length === 0 && (
                        <button className="primary-button" onClick={() => setView("hosts")} type="button">
                          Add an SSH host first
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="sftp-path">
                      <Folder size={14} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{sftp.path}</span>
                      {sftp.busy && <Loader2 className="spin" size={14} />}
                    </div>
                    {sftp.error && <div className="error-banner">{sftp.error}</div>}
                    <div>
                      {sftp.path !== "." && sftp.path !== "/" && (
                        <button
                          className="sftp-row is-dir"
                          onClick={() =>
                            browseSftp(
                              sftp.gatewaySessionId,
                              sftp.path.split("/").slice(0, -1).join("/") || ".",
                              sftp.hostName
                            )
                          }
                          type="button"
                        >
                          <Folder size={15} />
                          <strong>..</strong>
                          <span />
                          <span />
                        </button>
                      )}
                      {sftp.entries.map((entry) => (
                        <button
                          className={cx("sftp-row", entry.directory && "is-dir")}
                          disabled={!entry.directory}
                          key={entry.name}
                          onClick={() =>
                            entry.directory
                              ? browseSftp(
                                  sftp.gatewaySessionId,
                                  sftp.path === "." ? entry.name : `${sftp.path}/${entry.name}`,
                                  sftp.hostName
                                )
                              : undefined
                          }
                          type="button"
                        >
                          {entry.directory ? <Folder size={15} /> : <File size={15} />}
                          <strong>{entry.name}</strong>
                          <span>{entry.directory ? "directory" : formatBytes(entry.size)}</span>
                          <span />
                        </button>
                      ))}
                      {!sftp.busy && sftp.entries.length === 0 && !sftp.error && (
                        <EmptyState icon={<Folder size={20} />} title="Empty directory" />
                      )}
                    </div>
                  </>
                )}
              </section>
            )}

            {view === "vault" && (
              <VaultView
                credentials={credentials}
                hosts={hosts}
                loading={loading}
                notify={notify}
                onChanged={() => void consoleApi.credentials().then(setCredentials)}
                role={role}
              />
            )}

            {view === "snippets" && (
              <SnippetsView
                hasActiveTerminal={Boolean(activeTab)}
                loading={loading}
                notify={notify}
                onChanged={() => void consoleApi.snippets().then(setSnippets)}
                onRun={runSnippet}
                snippets={snippets}
              />
            )}

            {view === "team" && (
              <TeamView
                currentUser={identity.user}
                invitations={invitations}
                loading={loading}
                members={members}
                notify={notify}
                onChanged={() => void refreshAll()}
              />
            )}

            {view === "audit" && <AuditView loading={loading} logs={audit} memberNames={memberNames} />}

            {view === "settings" && (
              <SettingsView
                accent={accent}
                mode={mode}
                notify={notify}
                onAccent={handleAccent}
                onLogout={() => void logout()}
                onMode={handleMode}
                onProfileUpdated={(user) => setIdentity((current) => (current ? { ...current, user } : current))}
                organizationName={identity.organization?.name ?? "Workspace"}
                user={identity.user}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {toast && (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className={cx("console-toast", toast.kind)}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 8 }}
            role="status"
            transition={{ duration: 0.18 }}
          >
            {toast.kind === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Metric({
  color,
  icon: Icon,
  label,
  value,
  hint
}: {
  color: "green" | "cyan" | "amber" | "rose";
  icon: typeof Server;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className={cx("metric", color)}>
      <Icon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
      </div>
    </div>
  );
}

function formatBytes(size?: number) {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
