"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeftRight,
  Braces,
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Columns2,
  Copy,
  CreditCard,
  File,
  Folder,
  FolderLock,
  KeyRound,
  Laptop,
  Layers,
  ListTodo,
  LayoutDashboard,
  Loader2,
  LogOut,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  Star,
  Sun,
  Users,
  X
} from "lucide-react";
import type { AgentDevice, AppNotification, AuditLog, CredentialSummary, Host, Organization, RemoteSession, Snippet, ThemePreference, User } from "@onshell/shared";
import { canOpenSession, isShellHost } from "@onshell/shared";
import { cx } from "@onshell/ui";
import { ApiError, apiBaseUrl, consoleApi, keepSessionAlive, sessionWebsocketUrl } from "./api";
import type { MembershipSummary, PendingInvitation, TeamMember } from "./api";
import { FilesView } from "./files";
import { PlanUsagePanel, UpgradeBanner, useGrowth } from "./growth";
import {
  AgentsView,
  AuditView,
  EmptyState,
  HostsView,
  QuickLaunch,
  SettingsView,
  SnippetsView,
  TeamView,
  TasksView,
  VaultView,
  WorkspacesView
} from "./panels";
import type { TerminalStatus } from "./terminal";
import {
  EMPTY_TERMINAL_SETTINGS_STORE,
  TerminalSettingsPanel,
  loadTerminalSettings,
  saveTerminalSettings,
  settingsForHost,
  type TerminalSettings,
  type TerminalSettingsStore
} from "./terminal-settings";
import { OnshellMark } from "../brand";
import { useTheme } from "../theme";
import "./console.css";

const SIDEBAR_COLLAPSE_KEY = "onshell-sidebar-collapsed";

/**
 * How often an open console renews its own session. Well inside the 12-hour
 * access token, so a background tab is never the reason a terminal dies.
 */
const SESSION_KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000;

const XtermTerminal = dynamic(() => import("./terminal"), { ssr: false });

type ViewKey =
  | "overview"
  | "hosts"
  | "workspaces"
  | "agents"
  | "terminal"
  | "sftp"
  | "vault"
  | "snippets"
  | "tasks"
  | "team"
  | "billing"
  | "audit"
  | "settings";

interface TerminalTab {
  key: string;
  sessionId: string;
  hostId: string;
  hostName: string;
  websocketUrl: string;
  status: TerminalStatus;
  /** Why the last attempt failed, in the gateway's words. Cleared on retry. */
  error?: string;
}

interface Toast {
  message: string;
  kind: "success" | "error";
}

const navItems: Array<{ key: ViewKey; label: string; icon: typeof Server }> = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "hosts", label: "Hosts", icon: Server },
  // Directly under Hosts: a workspace is a saved set of them.
  { key: "workspaces", label: "Workspaces", icon: Layers },
  { key: "agents", label: "My computers", icon: Laptop },
  { key: "terminal", label: "Terminal", icon: SquareTerminal },
  { key: "sftp", label: "Files", icon: FolderLock },
  { key: "vault", label: "Vault", icon: KeyRound },
  { key: "snippets", label: "Snippets", icon: Braces },
  { key: "tasks", label: "Tasks", icon: ListTodo },
  { key: "team", label: "Team", icon: Users },
  { key: "billing", label: "Plan & billing", icon: CreditCard },
  { key: "audit", label: "Audit", icon: ScrollText },
  { key: "settings", label: "Settings", icon: Settings }
];

/**
 * Resolves `/console?view=billing` to a view key, so links from outside the
 * console (the profile menu, the assistant's upgrade prompt) land on the right
 * panel instead of the overview. Returns null for anything unrecognised.
 */
function requestedView(search: string): ViewKey | null {
  const requested = new URLSearchParams(search).get("view");
  return navItems.find((item) => item.key === requested)?.key ?? null;
}

function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Turns a raw open-session error code into an actionable message. */
function sessionErrorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.message : "";
  switch (code) {
    case "no_credential_for_host":
      return "This host has no credential attached. Add an SSH key or password in the Vault and attach it to this host, then try again.";
    case "credential_not_found":
      return "The selected credential no longer exists. Pick another one in the Vault.";
    case "host_not_found":
      return "That host no longer exists. Refresh the hosts list.";
    case "concurrent_session_limit_reached":
      return "You've reached your plan's limit of concurrent sessions. Close an open session or upgrade your plan.";
    case "forbidden":
      return "Your role can't open sessions. Ask an admin for access.";
    case "host_access_denied":
      return "You haven't been granted access to this host. Ask an owner or admin to add it to your host access.";
    default:
      return error instanceof Error && error.message ? error.message : "Could not open the session.";
  }
}

export function ConsoleApp() {
  const reduceMotion = useReducedMotion();
  const [identity, setIdentity] = useState<{ user: User; organization?: Organization } | null>(null);
  /**
   * Every workspace this account belongs to. Almost always one — the switcher
   * only exists for the person who was invited into somebody else's workspace
   * while already having their own, and a single-workspace user must not be
   * shown any of this.
   */
  const [organizations, setOrganizations] = useState<MembershipSummary[]>([]);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
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
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [agents, setAgents] = useState<AgentDevice[]>([]);
  const [audit, setAudit] = useState<AuditLog[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * Bumped to force every account-wide fetch to run again. Switching workspace
   * is the only thing that does it: plan, usage, and referral figures all belong
   * to the workspace that was left behind.
   */
  const [dataEpoch, setDataEpoch] = useState(0);
  /** Plan, usage, and referral data for the billing panel and upgrade nudge. */
  const growth = useGrowth(dataEpoch);

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [injected, setInjected] = useState<{ id: number; command: string; execute: boolean; targetKey: string } | null>(
    null
  );
  const injectedCounter = useRef(0);
  const [terminalLayout, setTerminalLayout] = useState<"single" | "split">("single");
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [snippetsPanelOpen, setSnippetsPanelOpen] = useState(false);
  const [tabPickerOpen, setTabPickerOpen] = useState(false);
  const tabPickerRef = useRef<HTMLDivElement>(null);
  /** Saved terminal appearance, per host. Loaded from this device on mount. */
  const [terminalSettings, setTerminalSettings] = useState<TerminalSettingsStore>(EMPTY_TERMINAL_SETTINGS_STORE);
  /**
   * Live overrides for the open tabs, keyed by tab. Two terminals on the *same*
   * host are two independent windows onto it and can be styled apart; what gets
   * written to storage is still per host, which is the identity that outlives
   * a connection.
   */
  const [tabSettings, setTabSettings] = useState<Record<string, TerminalSettings>>({});
  const [terminalSettingsOpen, setTerminalSettingsOpen] = useState(false);
  const terminalSettingsRef = useRef<HTMLDivElement>(null);
  /**
   * Host the Hosts view should open its edit drawer on when it next mounts —
   * set by the terminal's failure panel, cleared once the drawer has it.
   */
  const [editHostId, setEditHostId] = useState<string | null>(null);

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

  useEffect(() => { void consoleApi.notifications().then(setNotifications).catch(() => undefined); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (params.get("checkout") !== "success" || !sessionId) return;

    void fetch(`${apiBaseUrl}/payments/stripe/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("confirmation_failed");
        notify("Payment confirmed. Your package is active.");
        params.delete("checkout");
        params.delete("session_id");
        const query = params.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      })
      .catch(() => notify("Payment received; confirmation is still processing.", "error"));
  }, [notify]);

  // Restore saved terminal appearance after mount, so the server-rendered
  // markup and the first client render still agree.
  useEffect(() => {
    setTerminalSettings(loadTerminalSettings());
  }, []);

  /**
   * Renew the session for as long as this console is open.
   *
   * The access token is deliberately short-lived, and a console left open in a
   * background tab may go a long time without an API call to rotate it on. This
   * keeps the month-long refresh window sliding forward instead of expiring
   * under an open terminal.
   *
   * Coming back into view is the cheap trigger, but it is not enough on its own:
   * a console left open and untouched on a second monitor fires no focus and no
   * visibility event, ever, and used to be signed out from under a terminal that
   * was still running. So the timer below renews on its own schedule too — the
   * browser being open is the promise, and it has to hold without the user
   * having to prove it by clicking. `keepAlive` is idempotent within its own
   * minimum age, so the two triggers together still refresh at most once every
   * six hours.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void keepSessionAlive();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    // Not gated on visibility, unlike the listeners: a tab that has been in the
    // background the whole time is exactly the one whose session would otherwise
    // have quietly run out. Background timers are throttled to about once a
    // minute, which is far more often than this needs.
    const timer = window.setInterval(() => void keepSessionAlive(), SESSION_KEEPALIVE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // Honour ?view= after mount rather than in the initial state, so the server
  // and client render the same first frame.
  useEffect(() => {
    const requested = requestedView(window.location.search);
    if (requested) setView(requested);
  }, []);

  // Dismiss the new-tab host picker on an outside click or Escape.
  useEffect(() => {
    if (!tabPickerOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (tabPickerRef.current && !tabPickerRef.current.contains(event.target as Node)) setTabPickerOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setTabPickerOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [tabPickerOpen]);

  // Dismiss the appearance popover on an outside click or Escape.
  useEffect(() => {
    if (!terminalSettingsOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (terminalSettingsRef.current && !terminalSettingsRef.current.contains(event.target as Node)) {
        setTerminalSettingsOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setTerminalSettingsOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [terminalSettingsOpen]);

  /** What a tab is currently drawn with: its own override, else its host's. */
  const settingsForTab = useCallback(
    (tab: { key: string; hostId: string }) => tabSettings[tab.key] ?? settingsForHost(terminalSettings, tab.hostId),
    [tabSettings, terminalSettings]
  );

  /** Applies an edit to the focused tab and remembers it for the host. */
  const updateTerminalSettings = useCallback(
    (tab: { key: string; hostId: string }, patch: Partial<TerminalSettings>) => {
      const next: TerminalSettings = { ...settingsForTab(tab), ...patch };
      setTabSettings((current) => ({ ...current, [tab.key]: next }));
      setTerminalSettings((current) => {
        const store: TerminalSettingsStore = { ...current, byHost: { ...current.byHost, [tab.hostId]: next } };
        saveTerminalSettings(store);
        return store;
      });
    },
    [settingsForTab]
  );

  /** Drops this tab's and its host's settings, so both follow the default. */
  const resetTerminalSettings = useCallback((tab: { key: string; hostId: string }) => {
    setTabSettings((current) => {
      const next = { ...current };
      delete next[tab.key];
      return next;
    });
    setTerminalSettings((current) => {
      const byHost = { ...current.byHost };
      delete byHost[tab.hostId];
      const store: TerminalSettingsStore = { ...current, byHost };
      saveTerminalSettings(store);
      return store;
    });
  }, []);

  /**
   * Makes one terminal's look the default everywhere: open tabs lose their own
   * overrides, saved hosts lose theirs, and new terminals start from it.
   */
  const applyTerminalSettingsEverywhere = useCallback(
    (tab: { key: string; hostId: string }) => {
      const chosen = settingsForTab(tab);
      setTabSettings({});
      setTerminalSettings(() => {
        const store: TerminalSettingsStore = { fallback: chosen, byHost: {} };
        saveTerminalSettings(store);
        return store;
      });
    },
    [settingsForTab]
  );

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
      consoleApi.invitations().catch(() => [] as PendingInvitation[]),
      consoleApi.agents()
    ]);
    const [hostsR, credentialsR, sessionsR, snippetsR, auditR, orgR, invitationsR, agentsR] = results;
    if (hostsR.status === "fulfilled") setHosts(hostsR.value);
    if (credentialsR.status === "fulfilled") setCredentials(credentialsR.value);
    if (sessionsR.status === "fulfilled") setSessions(sessionsR.value);
    if (snippetsR.status === "fulfilled") setSnippets(snippetsR.value);
    if (agentsR.status === "fulfilled") setAgents(agentsR.value);
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

  /**
   * Establishes who is signed in and which workspace they are reading, then
   * loads that workspace. Run on mount and again after a workspace switch, so
   * there is one definition of "the console has been populated".
   *
   * `applyTheme` is off for a switch: the saved theme is per account, and
   * re-applying it would undo a light/dark toggle made since the page loaded.
   */
  const bootstrap = useCallback(
    async (options?: { applyTheme?: boolean }) => {
      const payload = await consoleApi.me();
      const user = (payload as { user?: User }).user ?? (payload as unknown as User);
      const organization = (payload as { organization?: Organization }).organization;
      setIdentity({ user, organization });
      setOrganizations(payload.organizations ?? []);

      // The server put us somewhere other than where the token asked for: the
      // membership was revoked while this session was live. Say so — the hosts
      // list changing under the user with no explanation is the bad outcome.
      const moved = payload.activeOrganizationChanged;
      if (moved) {
        notify(
          `You were removed from ${moved.previousOrganizationName ?? "that workspace"}. ` +
            `You are now in ${moved.organizationName ?? "another workspace"}.`,
          "error"
        );
      }

      if (options?.applyTheme !== false) {
        // Account theme wins on login, syncing this device to the saved choice.
        const pref = user.themePreference;
        if (pref?.mode) setMode(pref.mode);
        if (pref?.accent) setAccent(pref.accent);
      }
      await refreshAll();
    },
    [notify, refreshAll, setAccent, setMode]
  );

  useEffect(() => {
    let active = true;
    bootstrap()
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
    // Mount only: bootstrap is stable, and re-running it would refetch the whole
    // console on every notify.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* sessions */
  /**
   * Opens a session and shows it.
   *
   * Returns whether it succeeded, and takes `quiet` so a caller opening several
   * at once (a workspace) can summarise the outcome instead of firing one toast
   * per host, of which the user would only ever see the last.
   */
  const launchSession = useCallback(
    async (host: Host, protocol: "ssh" | "sftp" | "rdp", options?: { quiet?: boolean }): Promise<boolean> => {
      if (protocol === "rdp") {
        notify("RDP viewer ships in the next phase — the gateway bridge is ready, the browser client is not.", "error");
        return false;
      }
      try {
        const { session, websocketUrl } = await consoleApi.openSession({ hostId: host.id, protocol });
        if (protocol === "ssh") {
          const tab: TerminalTab = {
            key: `${session.id}-${Date.now()}`,
            sessionId: session.id,
            hostId: host.id,
            hostName: host.name,
            websocketUrl: sessionWebsocketUrl(session, websocketUrl),
            status: "connecting"
          };
          setTabs((current) => [...current, tab]);
          setActiveTab(tab.key);
          setView("terminal");
        }
        void consoleApi.sessions().then(setSessions).catch(() => undefined);
        return true;
      } catch (error) {
        const message = sessionErrorMessage(error);
        if (protocol === "ssh" && !options?.quiet) {
          // The failure opens a tab of its own rather than a toast that fades:
          // the reason and the two things worth doing about it (retry, edit the
          // host) belong where the terminal was going to be.
          const tab: TerminalTab = {
            key: `failed-${host.id}-${Date.now()}`,
            sessionId: "",
            hostId: host.id,
            hostName: host.name,
            websocketUrl: "",
            status: "error",
            error: message
          };
          setTabs((current) => [...current, tab]);
          setActiveTab(tab.key);
          setView("terminal");
        } else if (!options?.quiet) {
          notify(message, "error");
        }
        return false;
      }
    },
    [notify]
  );

  /**
   * Opens an SFTP session for the Files view, which manages two of them itself.
   * Throws on failure so the pane can render the reason in place.
   */
  const launchFileSession = useCallback(async (host: Host) => {
    const { session } = await consoleApi.openSession({ hostId: host.id, protocol: "sftp" });
    void consoleApi.sessions().then(setSessions).catch(() => undefined);
    return session.id;
  }, []);

  /**
   * Opens a terminal on every host in a saved workspace.
   *
   * Sequential on purpose: the plan's concurrent-session limit is checked per
   * request, so firing them in parallel would fail the tail of the list with an
   * error that looks random. Failures are collected and reported once.
   */
  const openWorkspaceTerminals = useCallback(
    async (hostIds: string[]) => {
      const targets = hostIds
        .map((hostId) => hosts.find((host) => host.id === hostId))
        .filter((host): host is Host => host !== undefined && isShellHost(host));

      if (targets.length === 0) {
        notify("None of this workspace's hosts can open a terminal.", "error");
        return;
      }

      setView("terminal");
      let opened = 0;
      const failed: string[] = [];
      for (const host of targets) {
        // eslint-disable-next-line no-await-in-loop -- deliberate: see above.
        const ok = await launchSession(host, "ssh", { quiet: true });
        if (ok) opened += 1;
        else failed.push(host.name);
      }

      if (failed.length === 0) {
        notify(`Opened ${opened} terminal${opened === 1 ? "" : "s"}.`);
      } else {
        notify(
          `Opened ${opened} of ${targets.length}. Could not open: ${failed.join(", ")}.`,
          opened === 0 ? "error" : "success"
        );
      }
    },
    [hosts, launchSession, notify]
  );

  const closeTab = useCallback((tab: TerminalTab) => {
    setTabs((current) => {
      const remaining = current.filter((item) => item.key !== tab.key);
      setActiveTab((active) => (active === tab.key ? (remaining.at(-1)?.key ?? null) : active));
      return remaining;
    });
    setTabSettings((current) => {
      if (!(tab.key in current)) return current;
      const next = { ...current };
      delete next[tab.key];
      return next;
    });
    // A tab that never got a session (the open call itself failed) has nothing
    // to close on the gateway.
    if (tab.sessionId) void consoleApi.closeSession(tab.sessionId).catch(() => undefined);
  }, []);

  // Reconnect a closed/failed tab by opening a fresh session for its host and
  // swapping the tab's socket URL in place (the terminal re-connects on change).
  const retryTab = useCallback(
    async (tab: TerminalTab) => {
      setTabs((current) =>
        current.map((item) => (item.key === tab.key ? { ...item, status: "connecting", error: undefined } : item))
      );
      if (tab.sessionId) void consoleApi.closeSession(tab.sessionId).catch(() => undefined);
      try {
        const { session, websocketUrl } = await consoleApi.openSession({ hostId: tab.hostId, protocol: "ssh" });
        setTabs((current) =>
          current.map((item) =>
            item.key === tab.key
              ? {
                  ...item,
                  sessionId: session.id,
                  websocketUrl: sessionWebsocketUrl(session, websocketUrl),
                  status: "connecting"
                }
              : item
          )
        );
        setActiveTab(tab.key);
        void consoleApi.sessions().then(setSessions).catch(() => undefined);
      } catch (error) {
        const message = sessionErrorMessage(error);
        setTabs((current) =>
          current.map((item) => (item.key === tab.key ? { ...item, status: "error", error: message } : item))
        );
      }
    },
    []
  );

  /**
   * Moves the console to another of the account's workspaces.
   *
   * The open terminals are the reason this is not just a re-fetch. Every tab is
   * a live socket to a machine belonging to the workspace being left, and the
   * new workspace has no claim on any of them — leaving them attached would put
   * organization A's shells inside organization B's console, which is the worst
   * possible reading of what a workspace boundary means. So they are closed,
   * gateway-side as well as locally, and because closing a live shell can throw
   * away work the user is asked first.
   *
   * Everything else the console holds belongs to the old workspace too: hosts,
   * credentials, sessions, snippets, agents, audit, the team, the plan. All of
   * it is cleared before the reload rather than left to be overwritten, so a
   * failed fetch shows an empty panel instead of the previous workspace's data.
   */
  const switchOrganization = useCallback(
    async (target: MembershipSummary) => {
      if (target.isActive || switchingTo) return;

      const liveTabs = tabs.filter((tab) => tab.status !== "closed" && tab.status !== "error");
      if (liveTabs.length > 0) {
        const confirmed = window.confirm(
          `Switching to ${target.name} will close ${liveTabs.length} open ` +
            `terminal${liveTabs.length === 1 ? "" : "s"} in ${identity?.organization?.name ?? "this workspace"}. ` +
            "Anything running in them will be interrupted. Continue?"
        );
        if (!confirmed) return;
      }

      setSwitchingTo(target.id);

      // Closed *before* the switch, not after, because a close is authorised
      // against the workspace that owns the session: once the session names the
      // new workspace, `POST /sessions/:id/close` for a host in the old one is
      // correctly refused, and the shells would be left running on the gateway
      // with no console attached to them. The cost is that a switch which then
      // fails has already discarded the terminals — which the user was asked
      // about, and is told about below.
      const closing = tabs.filter((tab) => tab.sessionId).map((tab) => tab.sessionId);
      setTabs([]);
      setActiveTab(null);
      setTabSettings({});
      setInjected(null);
      setTerminalFullscreen(false);
      setSnippetsPanelOpen(false);
      setTabPickerOpen(false);
      setTerminalSettingsOpen(false);
      await Promise.allSettled(closing.map((sessionId) => consoleApi.closeSession(sessionId)));

      try {
        await consoleApi.switchOrganization(target.id);
      } catch (error) {
        setSwitchingTo(null);
        const reason =
          error instanceof ApiError && error.status === 404
            ? "You are no longer a member of that workspace."
            : error instanceof Error
              ? error.message
              : "Could not switch workspace.";
        notify(
          closing.length > 0 ? `${reason} Your open terminals were closed.` : reason,
          "error"
        );
        return;
      }

      setHosts([]);
      setCredentials([]);
      setSessions([]);
      setSnippets([]);
      setAgents([]);
      setAudit([]);
      setMembers([]);
      setInvitations([]);
      setEditHostId(null);
      setLoading(true);
      setView("overview");
      setDataEpoch((epoch) => epoch + 1);

      try {
        await bootstrap({ applyTheme: false });
        notify(`Switched to ${target.name}.`);
      } catch {
        setLoadError("Switched workspace, but could not load it. Reload the page.");
        setLoading(false);
      } finally {
        setSwitchingTo(null);
      }
    },
    [bootstrap, identity, notify, switchingTo, tabs]
  );

  // Send a snippet to the active terminal. execute=true appends a newline (runs
  // it); execute=false pastes the text without running so the user can edit it.
  const sendSnippet = useCallback(
    (command: string, execute: boolean) => {
      if (!activeTab) {
        notify("Open a terminal first, then use the snippet.", "error");
        return;
      }
      injectedCounter.current += 1;
      setInjected({ id: injectedCounter.current, command, execute, targetKey: activeTab });
      setView("terminal");
    },
    [activeTab, notify]
  );

  const runSnippet = useCallback((command: string) => sendSnippet(command, true), [sendSnippet]);

  const copySnippet = useCallback(
    async (command: string) => {
      try {
        await navigator.clipboard.writeText(command);
        notify("Snippet copied to clipboard.", "success");
      } catch {
        notify("Could not copy — clipboard access was blocked.", "error");
      }
    },
    [notify]
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

  /**
   * Pins or unpins a host. Flipped locally first so the star responds at once,
   * then re-fetched: the list order is the API's business (favourites, then how
   * busy the machine has been), and guessing it here would make the row jump
   * twice.
   */
  const toggleFavorite = useCallback(
    async (host: Host) => {
      const next = !host.isFavorite;
      setHosts((current) =>
        current.map((item) => (item.id === host.id ? { ...item, isFavorite: next } : item)),
      );
      try {
        await consoleApi.setHostFavorite(host.id, next);
        setHosts(await consoleApi.hosts());
      } catch (error) {
        setHosts((current) =>
          current.map((item) => (item.id === host.id ? { ...item, isFavorite: !next } : item)),
        );
        notify(error instanceof Error ? error.message : "Could not update favourites.", "error");
      }
    },
    [notify]
  );

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
  /** Terminal-capable hosts, for the new-tab picker and the Files launcher. */
  const shellHosts = useMemo(() => hosts.filter(isShellHost), [hosts]);
  /** The tab the appearance popover edits — the focused one, or the only one. */
  const activeTabInfo = useMemo(
    () => tabs.find((tab) => tab.key === activeTab) ?? tabs.at(-1) ?? null,
    [tabs, activeTab]
  );

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
        {/* Only for accounts that really do have somewhere else to go. Someone
            with one workspace sees no extra control at all. */}
        {organizations.length > 1 && (
          <WorkspaceSwitcher
            activeName={identity.organization?.name ?? "Workspace"}
            collapsed={collapsed}
            onSelect={(target) => void switchOrganization(target)}
            organizations={organizations}
            reduceMotion={Boolean(reduceMotion)}
            switchingTo={switchingTo}
          />
        )}
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
          <div className="web-notification-anchor">
            <button aria-label="Notifications" className={cx("console-topright-btn", notificationsOpen && "is-active")} data-tooltip="Notifications" onClick={() => setNotificationsOpen((open) => !open)} type="button"><Bell size={16}/>{notifications.some((item) => !item.read) && <span className="console-topright-badge">{notifications.filter((item) => !item.read).length}</span>}</button>
            {notificationsOpen && <div className="web-notifications" role="dialog" aria-label="Notifications"><header><strong>Notifications</strong></header><div>{notifications.map((item) => <article className={item.read ? "" : "is-unread"} key={item.id} onClick={() => { if (!item.read) { void consoleApi.markNotificationRead(item.id); setNotifications((current) => current.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry)); } }}><strong>{item.title}</strong><p>{item.message}</p>{item.actionUrl && <a href={item.actionUrl} target="_blank" rel="noreferrer">Learn more</a>}</article>)}{notifications.length === 0 && <p className="web-notifications-empty">You’re all caught up.</p>}</div></div>}
          </div>
          <button
            aria-label="Open terminal"
            className={cx("console-topright-btn", view === "terminal" && "is-active")}
            data-tooltip={tabs.length > 0 ? `Terminal (${tabs.length} open)` : "Terminal"}
            onClick={() => setView("terminal")}
            type="button"
          >
            <SquareTerminal size={16} />
            {tabs.length > 0 && <span className="console-topright-badge">{tabs.length}</span>}
          </button>

          <button
            aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="console-topright-btn"
            data-tooltip={mode === "dark" ? "Light mode" : "Dark mode"}
            onClick={() => handleMode(mode === "dark" ? "light" : "dark")}
            type="button"
          >
            {mode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>

          {identity.user.isPlatformAdmin && (
            <button
              aria-label="Switch to admin panel"
              className="console-topright-btn"
              data-tooltip="Switch to admin panel"
              onClick={() => {
                window.location.href = "/admin";
              }}
              type="button"
            >
              <ArrowLeftRight size={16} />
            </button>
          )}

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
              <span className="pf-avatar">
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
                    <span className="pf-avatar lg">
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
                <UpgradeBanner growth={growth} onOpenBilling={() => setView("billing")} />
                <div className="metrics-grid">
                  <Metric color="green" hint="registered" icon={Server} label="Hosts" value={hosts.length} />
                  <Metric color="cyan" hint="live now" icon={SquareTerminal} label="Active Sessions" value={activeSessions.length} />
                  <Metric color="amber" hint="encrypted" icon={KeyRound} label="Vault Items" value={credentials.length} />
                  <Metric color="rose" hint="recent" icon={ScrollText} label="Audit Events" value={audit.length} />
                </div>
                <QuickLaunch
                  canOpen={canOpenSession(role)}
                  hosts={hosts}
                  onBrowse={() => setView("hosts")}
                  onLaunch={(host) => void launchSession(host, "ssh")}
                  onToggleFavorite={(host) => void toggleFavorite(host)}
                />

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
                credentials={credentials}
                editHostId={editHostId}
                error={loadError}
                hosts={hosts}
                loading={loading}
                notify={notify}
                onEditHostConsumed={() => setEditHostId(null)}
                onCreated={() => void consoleApi.hosts().then(setHosts)}
                onCredentialsChanged={() => void consoleApi.credentials().then(setCredentials)}
                onDelete={deleteHost}
                onLaunch={launchSession}
                onRefresh={() => void consoleApi.hosts().then(setHosts).catch(() => notify("Refresh failed.", "error"))}
                onToggleFavorite={(host) => void toggleFavorite(host)}
                role={role}
              />
            )}

            {view === "workspaces" && (
              <WorkspacesView
                hosts={hosts}
                notify={notify}
                onOpenWorkspace={(hostIds) => void openWorkspaceTerminals(hostIds)}
                role={role}
              />
            )}

            {view === "sftp" && (
              <FilesView hosts={hosts} notify={notify} onLaunchFileSession={launchFileSession} />
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

            {view === "agents" && (
              <AgentsView
                devices={agents}
                loading={loading}
                notify={notify}
                // Pairing creates a host too, so the hosts list has to catch up
                // or the newly connected machine is missing from it until reload.
                onChanged={() => {
                  void consoleApi.agents().then(setAgents);
                  void consoleApi.hosts().then(setHosts);
                }}
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
            {view === "tasks" && <TasksView />}

            {view === "team" && (
              <TeamView
                currentUser={identity.user}
                hosts={hosts}
                invitations={invitations}
                loading={loading}
                members={members}
                notify={notify}
                onChanged={() => void refreshAll()}
              />
            )}

            {view === "billing" && (
              <>
                <div className="topbar">
                  <div>
                    <h1>Plan &amp; billing</h1>
                    <p>What your workspace is using, and what the next tier unlocks.</p>
                  </div>
                </div>
                <PlanUsagePanel growth={growth} />
              </>
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
                onOrgUpdated={(organization) =>
                  setIdentity((current) => (current ? { ...current, organization } : current))
                }
                onProfileUpdated={(user) => setIdentity((current) => (current ? { ...current, user } : current))}
                organization={identity.organization}
                organizationName={identity.organization?.name ?? "Workspace"}
                user={identity.user}
              />
            )}
          </motion.div>
        </AnimatePresence>

        {/* Terminal workspace stays mounted across view switches so open
            sessions (and their WebSockets) survive navigating to other menus. */}
        <section
          className={cx("panel", "terminal-workspace", terminalFullscreen && "is-fullscreen")}
          style={view === "terminal" ? undefined : { display: "none" }}
        >
          <div className="panel-header tight">
            <div>
              <h2>Terminal</h2>
              <p>Live SSH over the Onshell gateway — every session is audited.</p>
            </div>
            {tabs.length > 0 && (
              <div className="terminal-controls">
                <button
                  aria-pressed={terminalLayout === "split"}
                  className={cx("icon-button", terminalLayout === "split" && "is-active")}
                  onClick={() => setTerminalLayout((mode) => (mode === "split" ? "single" : "split"))}
                  title={terminalLayout === "split" ? "Single terminal" : "Split — show all terminals"}
                  type="button"
                >
                  {terminalLayout === "split" ? <SquareTerminal size={15} /> : <Columns2 size={15} />}
                </button>
                <button
                  aria-pressed={snippetsPanelOpen}
                  className={cx("icon-button", snippetsPanelOpen && "is-active")}
                  onClick={() => setSnippetsPanelOpen((open) => !open)}
                  title={snippetsPanelOpen ? "Hide snippets" : "Show snippets"}
                  type="button"
                >
                  {snippetsPanelOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
                </button>
                {/* Appearance is per terminal, so the button lives with the
                    other terminal controls and edits whichever tab is active. */}
                <div className="terminal-settings-anchor" ref={terminalSettingsRef}>
                  <button
                    aria-expanded={terminalSettingsOpen}
                    aria-haspopup="dialog"
                    className={cx("icon-button", terminalSettingsOpen && "is-active")}
                    disabled={!activeTabInfo}
                    onClick={() => setTerminalSettingsOpen((open) => !open)}
                    title="Terminal appearance (theme & font size)"
                    type="button"
                  >
                    <SlidersHorizontal size={15} />
                  </button>

                  {terminalSettingsOpen && activeTabInfo && (
                    <TerminalSettingsPanel
                      hostName={activeTabInfo.hostName}
                      onApplyToAll={() => applyTerminalSettingsEverywhere(activeTabInfo)}
                      onChange={(patch) => updateTerminalSettings(activeTabInfo, patch)}
                      onClose={() => setTerminalSettingsOpen(false)}
                      onReset={() => resetTerminalSettings(activeTabInfo)}
                      settings={settingsForTab(activeTabInfo)}
                      usingFallback={
                        tabSettings[activeTabInfo.key] === undefined &&
                        terminalSettings.byHost[activeTabInfo.hostId] === undefined
                      }
                    />
                  )}
                </div>
                <button
                  aria-pressed={terminalFullscreen}
                  className={cx("icon-button", terminalFullscreen && "is-active")}
                  onClick={() => setTerminalFullscreen((full) => !full)}
                  title={terminalFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  type="button"
                >
                  {terminalFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </button>
              </div>
            )}
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

                {/* Opening a second session otherwise meant leaving the terminal
                    for the hosts list and coming back. */}
                <div className="terminal-tab-add" ref={tabPickerRef}>
                  <button
                    aria-expanded={tabPickerOpen}
                    aria-haspopup="menu"
                    aria-label="Open a session on another host"
                    className="terminal-tab-add-btn"
                    onClick={() => setTabPickerOpen((open) => !open)}
                    title="Open another host"
                    type="button"
                  >
                    <Plus size={14} />
                  </button>

                  {tabPickerOpen && (
                    <div className="terminal-tab-menu" role="menu">
                      <p className="terminal-tab-menu-head">Open a terminal on</p>
                      {shellHosts.length === 0 && (
                        <p className="terminal-tab-menu-empty">No SSH hosts yet.</p>
                      )}
                      {shellHosts.map((host) => (
                        <button
                          key={host.id}
                          onClick={() => {
                            setTabPickerOpen(false);
                            void launchSession(host, "ssh");
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <Server size={14} />
                          <span className="terminal-tab-menu-name">{host.name}</span>
                          <small>{host.address}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="terminal-body">
                <div
                  className={cx("terminal-stage", terminalLayout === "split" && "is-split")}
                  data-count={tabs.length}
                >
                  {tabs.map((tab) => {
                    const visible = terminalLayout === "split" || activeTab === tab.key;
                    const host = hosts.find((item) => item.id === tab.hostId);
                    return (
                      <div
                        className={cx(
                          "terminal-pane",
                          // Nothing inside this pane has a height of its own when
                          // there is no terminal in it, and the failure notice
                          // below is positioned against the pane — so without
                          // this the tab reports its error into a zero-pixel box
                          // and the user sees a red dot above an empty console.
                          !tab.websocketUrl && "is-empty",
                          terminalLayout === "split" && activeTab === tab.key && "is-focused"
                        )}
                        key={tab.key}
                        onMouseDown={() => setActiveTab(tab.key)}
                        style={{ display: visible ? "block" : "none" }}
                      >
                        {/* A tab whose session never opened has no socket to
                            connect to — it exists only to carry the failure. */}
                        {tab.websocketUrl && (
                          <XtermTerminal
                            injectedCommand={injected?.targetKey === tab.key ? injected : null}
                            settings={settingsForTab(tab)}
                            onStatusChange={(status, detail) =>
                              setTabs((current) =>
                                current.map((item) =>
                                  item.key === tab.key
                                    ? { ...item, status, error: detail ?? (status === "error" ? item.error : undefined) }
                                    : item
                                )
                              )
                            }
                            websocketUrl={tab.websocketUrl}
                          />
                        )}
                        {(tab.status === "closed" || tab.status === "error") && (
                          <div className="terminal-retry">
                            <strong>
                              {tab.status === "error"
                                ? `Couldn't connect to ${tab.hostName}.`
                                : `Session to ${tab.hostName} closed.`}
                            </strong>
                            {tab.error && <p className="terminal-retry-detail">{tab.error}</p>}
                            {host && (
                              <p className="terminal-retry-target">
                                {host.username ? `${host.username}@` : ""}
                                {host.address}:{host.port} · {host.type.toUpperCase()}
                              </p>
                            )}
                            <div className="terminal-retry-actions">
                              <button className="primary-button" onClick={() => void retryTab(tab)} type="button">
                                <RefreshCw size={15} />
                                Retry
                              </button>
                              {/* The usual fix for a refused or rejected
                                  connection is a wrong address, port, username
                                  or credential — all of them one form away. */}
                              {host && (
                                <button
                                  className="secondary-button"
                                  onClick={() => {
                                    setEditHostId(host.id);
                                    setView("hosts");
                                  }}
                                  type="button"
                                >
                                  <Settings size={15} />
                                  Edit host
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {snippetsPanelOpen && (
                  <aside className="terminal-snippets">
                    <div className="terminal-snippets-head">
                      <ScrollText size={14} />
                      <strong>Snippets</strong>
                    </div>
                    {snippets.length === 0 ? (
                      <p className="terminal-snippets-empty">
                        No snippets yet. Create reusable commands in the Snippets menu.
                      </p>
                    ) : (
                      <ul className="terminal-snippets-list">
                        {snippets.map((snippet) => (
                          <li className="terminal-snippet" key={snippet.id}>
                            <div className="terminal-snippet-info">
                              <span className="terminal-snippet-name">{snippet.name}</span>
                              <code>{snippet.command}</code>
                            </div>
                            <div className="terminal-snippet-actions">
                              <button
                                aria-label={`Copy ${snippet.name}`}
                                className="icon-button compact"
                                onClick={() => void copySnippet(snippet.command)}
                                title="Copy to clipboard"
                                type="button"
                              >
                                <Copy size={13} />
                              </button>
                              <button
                                aria-label={`Paste ${snippet.name} into terminal`}
                                className="icon-button compact"
                                onClick={() => sendSnippet(snippet.command, false)}
                                title="Paste into terminal (does not run)"
                                type="button"
                              >
                                <ClipboardPaste size={13} />
                              </button>
                              <button
                                aria-label={`Run ${snippet.name}`}
                                className="icon-button compact"
                                onClick={() => sendSnippet(snippet.command, true)}
                                title="Run in terminal"
                                type="button"
                              >
                                <Play size={13} />
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </aside>
                )}
              </div>
            </>
          )}
        </section>
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

/**
 * The workspace picker in the sidebar, for accounts that belong to more than one.
 *
 * It states the role held in each workspace rather than only the name, because
 * they differ: the case this exists for is somebody who owns their own workspace
 * and was invited into a colleague's as a developer, and "what will I be able to
 * do over there" is the question they are actually asking.
 */
function WorkspaceSwitcher({
  activeName,
  collapsed,
  onSelect,
  organizations,
  reduceMotion,
  switchingTo
}: {
  activeName: string;
  collapsed: boolean;
  onSelect: (target: MembershipSummary) => void;
  organizations: MembershipSummary[];
  reduceMotion: boolean;
  switchingTo: string | null;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (anchor.current && !anchor.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="workspace-switcher" ref={anchor}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Workspace: ${activeName}. Switch workspace`}
        className={cx("workspace-switch-trigger", open && "is-open")}
        disabled={switchingTo !== null}
        onClick={() => setOpen((current) => !current)}
        title={collapsed ? `Workspace: ${activeName}` : undefined}
        type="button"
      >
        {switchingTo ? <Loader2 className="workspace-switch-spin" size={15} /> : <Building2 size={15} />}
        <span className="nav-label workspace-switch-name">{activeName}</span>
        <ChevronDown className="nav-label workspace-switch-chevron" size={14} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="workspace-switch-menu"
            exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            role="menu"
            transition={{ duration: 0.14, ease: "easeOut" }}
          >
            <p className="workspace-switch-head">Your workspaces</p>
            {organizations.map((organization) => (
              <button
                aria-current={organization.isActive}
                className={cx("workspace-switch-item", organization.isActive && "is-active")}
                disabled={switchingTo !== null}
                key={organization.id}
                onClick={() => {
                  setOpen(false);
                  onSelect(organization);
                }}
                role="menuitem"
                type="button"
              >
                <span className="workspace-switch-item-copy">
                  <strong>{organization.name}</strong>
                  <small>{organization.role}</small>
                </span>
                {organization.isActive && <Check size={14} />}
              </button>
            ))}
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
