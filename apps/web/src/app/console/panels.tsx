"use client";

import {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Braces,
  Building2,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Inbox,
  KeyRound,
  Laptop,
  Layers,
  Loader2,
  LogOut,
  Mail,
  MonitorSmartphone,
  MonitorUp,
  Palette,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  UserPlus,
  UserRound,
  X,
} from "lucide-react";
import type {
  AgentDevice,
  AuditLog,
  CredentialSummary,
  Host,
  Organization,
  Role,
  Snippet,
  User,
} from "@onshell/shared";
import {
  canManageHosts,
  canManageUsers,
  canOpenSession,
  passwordPolicy,
  roles,
  validatePassword,
} from "@onshell/shared";
import { cx } from "@onshell/ui";
import type {
  HostExportFormat,
  HostWorkspace,
  MemberHostAccess,
  PendingInvitation,
  TeamMember,
} from "./api";
import { consoleApi } from "./api";
import { HostTransferPanel } from "./host-transfer";
import type { AccentValue, ThemeMode } from "../theme";
import { ACCENT_PRESETS, accentToHex, isDefaultAccent } from "../theme";

/* ---------- shared bits ---------- */

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="empty-state">
      {icon}
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          animate={{ opacity: 1 }}
          className="drawer-overlay"
          exit={{ opacity: 0 }}
          initial={{ opacity: reduceMotion ? 1 : 0 }}
          onClick={onClose}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="drawer-card"
            exit={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
            initial={{
              opacity: reduceMotion ? 1 : 0,
              y: reduceMotion ? 0 : 16,
            }}
            onClick={(event) => event.stopPropagation()}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="drawer-head">
              <div>
                <h2>{title}</h2>
                {subtitle && <p>{subtitle}</p>}
              </div>
              <button
                aria-label="Close"
                className="icon-button compact"
                onClick={onClose}
                type="button"
              >
                <X size={15} />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SubmitButton({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button className="primary-button" disabled={busy} type="submit">
      {busy ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
      {label}
    </button>
  );
}

/* ---------- Reusable data table (search · sort · pagination) ---------- */

type SortDir = "asc" | "desc";

interface DataColumn<T> {
  key: string;
  header: string;
  /** CSS grid track for this column, e.g. "minmax(160px, 1.4fr)". */
  width: string;
  render: (row: T) => ReactNode;
  /** When provided, the column header becomes a sort toggle. */
  sortValue?: (row: T) => string | number;
  align?: "center" | "end";
}

/** Short numeric page list with gaps, e.g. [1, "…", 4, 5, 6, "…", 20]. */
function pageWindow(current: number, total: number): Array<number | "gap"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  let prev = 0;
  for (const page of sorted) {
    if (page - prev > 1) out.push("gap");
    out.push(page);
    prev = page;
  }
  return out;
}

function DataTable<T>({
  rows,
  columns,
  rowKey,
  searchText,
  searchPlaceholder = "Search…",
  pageSize = 10,
  defaultSort,
  loading,
  empty,
  leftTools,
  rightTools,
}: {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
  pageSize?: number;
  defaultSort?: { key: string; dir: SortDir };
  loading?: boolean;
  empty: { icon: ReactNode; title: string; hint?: string };
  leftTools?: ReactNode;
  rightTools?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(defaultSort ?? null);
  const [page, setPage] = useState(1);

  const gridCols = useMemo(() => columns.map((column) => column.width).join(" "), [columns]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !searchText) return rows;
    return rows.filter((row) => searchText(row).toLowerCase().includes(needle));
  }, [rows, query, searchText]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((item) => item.key === sort.key);
    if (!column?.sortValue) return filtered;
    const direction = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = column.sortValue!(a);
      const bv = column.sortValue!(b);
      if (av < bv) return -direction;
      if (av > bv) return direction;
      return 0;
    });
  }, [filtered, sort, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  // Snap back to the first page whenever the result set changes shape.
  useEffect(() => {
    setPage(1);
  }, [query, sort, rows.length]);

  const toggleSort = useCallback((key: string) => {
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }, []);

  return (
    <div className="data-table">
      {(searchText || leftTools || rightTools) && (
        <div className="data-toolbar">
          {searchText && (
            <div className="search-field">
              <Search size={15} />
              <input
                aria-label={searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                value={query}
              />
            </div>
          )}
          {leftTools}
          <span className="data-toolbar-spacer" />
          {rightTools}
        </div>
      )}

      {loading ? (
        <div className="data-grid">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState hint={empty.hint} icon={empty.icon} title={empty.title} />
      ) : sorted.length === 0 ? (
        <EmptyState
          hint="Try a different search term."
          icon={<Search size={22} />}
          title="Nothing matches your search"
        />
      ) : (
        <>
          <div className="data-scroll">
            <div className="data-grid" style={{ "--cols": gridCols } as CSSProperties}>
              <div className="data-grid-row is-head">
                {columns.map((column) => {
                  const active = sort?.key === column.key;
                  return (
                    <span
                      className={cx(column.align === "end" && "col-end", column.align === "center" && "col-center")}
                      key={column.key}
                    >
                      {column.sortValue ? (
                        <button
                          className={cx("data-sort", active && "is-active")}
                          onClick={() => toggleSort(column.key)}
                          type="button"
                        >
                          {column.header}
                          {active ? (
                            sort?.dir === "asc" ? (
                              <ArrowUp size={12} />
                            ) : (
                              <ArrowDown size={12} />
                            )
                          ) : (
                            <ArrowUpDown className="data-sort-idle" size={12} />
                          )}
                        </button>
                      ) : (
                        column.header
                      )}
                    </span>
                  );
                })}
              </div>
              {pageRows.map((row) => (
                <div className="data-grid-row" key={rowKey(row)}>
                  {columns.map((column) => (
                    <div
                      className={cx(
                        "data-cell",
                        column.align === "end" && "col-end",
                        column.align === "center" && "col-center",
                      )}
                      key={column.key}
                    >
                      {column.render(row)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="data-pagination">
            <span className="pager-info">
              {start + 1}–{Math.min(start + pageSize, sorted.length)} of {sorted.length}
            </span>
            {totalPages > 1 && (
              <div className="data-pager">
                <button
                  aria-label="Previous page"
                  disabled={currentPage === 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  type="button"
                >
                  <ChevronLeft size={14} />
                </button>
                {pageWindow(currentPage, totalPages).map((item, index) =>
                  item === "gap" ? (
                    <span className="pager-gap" key={`gap-${index}`}>
                      …
                    </span>
                  ) : (
                    <button
                      className={cx(item === currentPage && "is-current")}
                      key={item}
                      onClick={() => setPage(item)}
                      type="button"
                    >
                      {item}
                    </button>
                  ),
                )}
                <button
                  aria-label="Next page"
                  disabled={currentPage === totalPages}
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                  type="button"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const AVATAR_PALETTE = ["#6366f1", "#0891b2", "#059669", "#d97706", "#db2777", "#7c3aed"];

/** Small identity avatar for table rows — image when available, initials otherwise. */
function TableAvatar({ name, url, size = 32 }: { name: string; url?: string | null; size?: number }) {
  const initials = useMemo(() => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }, [name]);
  const tint = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  }, [name]);
  return (
    <span className="tbl-avatar" style={{ width: size, height: size, background: url ? undefined : tint }}>
      {url ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img alt="" src={url} />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}

/** Locale date like "Jul 20, 2026", or an em dash when missing. */
function shortDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "3 days ago" style relative label, or an em dash when missing. */
function relativeTime(value?: string) {
  if (!value) return "—";
  const then = new Date(value).getTime();
  const diffMs = then - Date.now();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < hour) return rtf.format(Math.round(diffMs / minute), "minute");
  if (abs < day) return rtf.format(Math.round(diffMs / hour), "hour");
  if (abs < 30 * day) return rtf.format(Math.round(diffMs / day), "day");
  return shortDate(value);
}

/** Confirmation modal for destructive actions (delete, revoke). */
function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Delete",
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Drawer onClose={onClose} open={open} title={title}>
      <div className="confirm-body">
        <p>{message}</p>
        <div className="confirm-actions">
          <button className="secondary-button" disabled={busy} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="danger-button solid" disabled={busy} onClick={onConfirm} type="button">
            {busy ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

/* ---------- Hosts ---------- */

const protocolIcons = {
  ssh: SquareTerminal,
  rdp: MonitorUp,
  vnc: MonitorUp,
  // Someone's own computer rather than a server, and the list should read that
  // way at a glance.
  agent: Laptop,
} as const;

/**
 * Export formats offered straight from the hosts table. Deliberately the same
 * set (and order) as the import/export workspace so the two do not drift; the
 * labels are shorter here because they sit in a toolbar, not on a card.
 */
const HOST_EXPORT_FORMATS: Array<{ value: HostExportFormat; label: string; hint: string }> = [
  { value: "json", label: "JSON", hint: "Re-importable into Onshell. Keeps groups, tags, and notes." },
  { value: "csv", label: "CSV", hint: "Opens in Excel or Sheets. Also imports into Termius." },
  { value: "ssh-config", label: "SSH config", hint: "Drop into ~/.ssh/config. SSH hosts only." },
];

export function HostsView({
  hosts,
  credentials,
  role,
  loading,
  error,
  onLaunch,
  onDelete,
  onRefresh,
  onCreated,
  onCredentialsChanged,
  onOpenWorkspace,
  notify,
}: {
  hosts: Host[];
  credentials: CredentialSummary[];
  role: Role;
  loading: boolean;
  error: string | null;
  onLaunch: (host: Host, protocol: "ssh" | "sftp" | "rdp") => void;
  onDelete: (host: Host) => void;
  onRefresh: () => void;
  onCreated: () => void;
  onCredentialsChanged: () => void;
  /**
   * Opens one terminal per host id, in the order given — the point of a
   * workspace. Only this view knows which of a workspace's hosts are still
   * reachable, so it does the filtering and hands over a list that is ready to
   * launch.
   *
   * Optional only until page.tsx passes it: the console owns the tab strip, and
   * a required prop here would break the build of a file this change does not
   * touch. The button is disabled while it is absent rather than silently
   * doing nothing.
   */
  onOpenWorkspace: (hostIds: string[]) => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "ssh" | "rdp" | "vnc">(
    "all",
  );
  const [adding, setAdding] = useState(false);
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [busy, setBusy] = useState(false);
  /** "hosts" is the table; "transfer" is the import/export workspace. */
  const [hostsTab, setHostsTab] = useState<"hosts" | "transfer">("hosts");
  /**
   * Export selection, keyed by host id rather than by row index so it survives
   * searching, type filtering and sorting — a selection that silently retargeted
   * itself when the filter changed would be a data-leak footgun on export.
   */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // The vault credential (if any) currently attached to a host.
  const credentialForHost = (hostId: string) =>
    credentials.find((credential) => credential.attachedHostIds.includes(hostId)) ?? null;

  const filtered = useMemo(
    () =>
      hosts.filter((host) => {
        if (typeFilter !== "all" && host.type !== typeFilter) return false;
        const haystack =
          `${host.name} ${host.address} ${host.tags.join(" ")} ${host.group ?? ""}`.toLowerCase();
        return haystack.includes(query.toLowerCase());
      }),
    [hosts, query, typeFilter],
  );

  // A host can vanish between refreshes (deleted here or elsewhere, or a grant
  // revoked). Dropping its id keeps the count honest and stops the export URL
  // carrying ids the API would only ignore. Returning `prev` unchanged when
  // nothing was stale keeps this from looping.
  useEffect(() => {
    setSelectedIds((prev) => {
      const live = prev.filter((id) => hosts.some((host) => host.id === id));
      return live.length === prev.length ? prev : live;
    });
  }, [hosts]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedVisibleCount = filtered.reduce(
    (total, host) => total + (selectedSet.has(host.id) ? 1 : 0),
    0,
  );
  const allVisibleSelected = filtered.length > 0 && selectedVisibleCount === filtered.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  const toggleSelected = useCallback((hostId: string) => {
    setSelectedIds((prev) =>
      prev.includes(hostId) ? prev.filter((id) => id !== hostId) : [...prev, hostId],
    );
  }, []);

  // Select-all works on what is currently on screen; hosts hidden by the filter
  // keep whatever state they had, so narrowing the filter is never destructive.
  const toggleAllVisible = useCallback(() => {
    const visibleIds = filtered.map((host) => host.id);
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const visible = new Set(visibleIds);
        return prev.filter((id) => !visible.has(id));
      }
      return [...new Set([...prev, ...visibleIds])];
    });
  }, [allVisibleSelected, filtered]);

  const exportLabel = selectedIds.length > 0 ? `Export ${selectedIds.length} selected` : "Export all";

  /* ---- saved host workspaces ---- */

  const [workspaces, setWorkspaces] = useState<HostWorkspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<HostWorkspace | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<HostWorkspace | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  // Workspaces load independently of the hosts list: a failure here must not
  // take down the table, which is the reason this view exists.
  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await consoleApi.workspaces());
      setWorkspaceError(null);
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : "Could not load workspaces.");
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const hostIdSet = useMemo(() => new Set(hosts.map((host) => host.id)), [hosts]);

  /**
   * Workspace names are unique per organization, so the API answers a clash with
   * the generic `already_exists` code. Translated here rather than in the API:
   * the code is what other callers key off, and only this form knows that the
   * colliding thing was a name the user just typed.
   */
  function workspaceFailure(err: unknown, fallback: string) {
    const message = err instanceof Error ? err.message : "";
    if (message === "already_exists") return "A workspace with that name already exists.";
    return message || fallback;
  }

  /**
   * A workspace's hosts as they stand right now. A host can be deleted, or a
   * grant revoked, long after the workspace was saved, so the stored ids are
   * intersected with the hosts actually on hand before anything is opened —
   * launching a session for a host that is gone would only produce an error per
   * tab.
   */
  const liveHostIds = useCallback(
    (workspace: HostWorkspace) => workspace.hostIds.filter((id) => hostIdSet.has(id)),
    [hostIdSet],
  );

  function openWorkspace(workspace: HostWorkspace) {
    const ids = liveHostIds(workspace);
    if (ids.length === 0) {
      notify(`No host in "${workspace.name}" is available right now.`, "error");
      return;
    }
    onOpenWorkspace(ids);
  }

  async function submitWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setWorkspaceBusy(true);
    try {
      const saved = await consoleApi.createWorkspace({
        name: String(data.get("name") ?? ""),
        description: String(data.get("description") ?? "") || undefined,
        hostIds: selectedIds,
      });
      // The API stores only the hosts this member holds a grant for, so the count
      // it echoes back — not the number ticked — is what the workspace will open.
      const dropped = selectedIds.length - saved.hostIds.length;
      notify(
        dropped > 0
          ? `Saved "${saved.name}" with ${saved.hostIds.length} hosts — ${dropped} were unavailable.`
          : `Saved "${saved.name}" with ${saved.hostIds.length} hosts.`,
        dropped > 0 ? "error" : "success",
      );
      setSavingWorkspace(false);
      setSelectedIds([]);
      await loadWorkspaces();
    } catch (err) {
      notify(workspaceFailure(err, "Could not save workspace."), "error");
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function submitWorkspaceEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingWorkspace) return;
    const data = new FormData(event.currentTarget);
    const replaceHosts = data.get("replaceHosts") === "on";
    setWorkspaceBusy(true);
    try {
      await consoleApi.updateWorkspace(editingWorkspace.id, {
        name: String(data.get("name") ?? ""),
        // Null clears the note; an empty string would only store whitespace.
        description: String(data.get("description") ?? "") || null,
        // Left off entirely unless asked for, so a rename never rewrites the set.
        ...(replaceHosts && { hostIds: selectedIds }),
      });
      notify("Workspace updated.", "success");
      setEditingWorkspace(null);
      if (replaceHosts) setSelectedIds([]);
      await loadWorkspaces();
    } catch (err) {
      notify(workspaceFailure(err, "Could not update workspace."), "error");
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function confirmWorkspaceDelete() {
    if (!deletingWorkspace) return;
    setWorkspaceBusy(true);
    try {
      await consoleApi.deleteWorkspace(deletingWorkspace.id);
      notify(`Workspace "${deletingWorkspace.name}" deleted.`, "success");
      setDeletingWorkspace(null);
      await loadWorkspaces();
    } catch (err) {
      notify(workspaceFailure(err, "Could not delete workspace."), "error");
    } finally {
      setWorkspaceBusy(false);
    }
  }

  // Attach a vault credential to a host without disturbing its other hosts.
  async function attachCredential(credentialId: string, hostId: string) {
    const credential = credentials.find((item) => item.id === credentialId);
    if (!credential || credential.attachedHostIds.includes(hostId)) return;
    await consoleApi.updateCredential(credentialId, {
      attachedHostIds: [...credential.attachedHostIds, hostId],
    });
  }

  async function detachCredential(credentialId: string, hostId: string) {
    const credential = credentials.find((item) => item.id === credentialId);
    if (!credential) return;
    await consoleApi.updateCredential(credentialId, {
      attachedHostIds: credential.attachedHostIds.filter((id) => id !== hostId),
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const credentialId = String(data.get("credentialId") ?? "");
    setBusy(true);
    try {
      const created = (await consoleApi.createHost({
        name: String(data.get("name") ?? ""),
        type: String(data.get("type") ?? "ssh"),
        address: String(data.get("address") ?? ""),
        port: Number(data.get("port") ?? 22),
        username: String(data.get("username") ?? "") || undefined,
        environment: String(data.get("environment") ?? "development"),
        group: String(data.get("group") ?? "") || undefined,
        tags: String(data.get("tags") ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      })) as { id?: string };
      if (credentialId && created?.id) {
        await attachCredential(credentialId, created.id);
        onCredentialsChanged();
      }
      notify("Host added.", "success");
      setAdding(false);
      onCreated();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not add host.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingHost) return;
    const host = editingHost;
    const data = new FormData(event.currentTarget);
    const credentialId = String(data.get("credentialId") ?? "");
    const current = credentialForHost(host.id);
    setBusy(true);
    try {
      await consoleApi.updateHost(host.id, {
        name: String(data.get("name") ?? ""),
        type: String(data.get("type") ?? "ssh"),
        address: String(data.get("address") ?? ""),
        port: Number(data.get("port") ?? 22),
        username: String(data.get("username") ?? "") || undefined,
        environment: String(data.get("environment") ?? "development"),
        group: String(data.get("group") ?? "") || null,
        tags: String(data.get("tags") ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      if ((current?.id ?? "") !== credentialId) {
        if (current) await detachCredential(current.id, host.id);
        if (credentialId) await attachCredential(credentialId, host.id);
        onCredentialsChanged();
      }
      notify("Host updated.", "success");
      setEditingHost(null);
      onCreated();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not update host.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // Import/export takes over the view rather than sitting under the table: the
  // preview grid needs the full width, and it is a deliberate detour, not
  // something you want beneath the list you were just reading.
  if (hostsTab === "transfer") {
    return (
      <div className="ht-stack">
        <div className="ht-back">
          <button className="secondary-button" onClick={() => setHostsTab("hosts")} type="button">
            <ChevronLeft size={15} />
            Back to hosts
          </button>
        </div>
        <HostTransferPanel
          notify={notify}
          onImported={() => {
            onRefresh();
            onCreated();
          }}
        />
      </div>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Hosts</h2>
          <p>Servers your team can reach through the gateway.</p>
        </div>
        <div className="table-tools">
          <div
            className="segmented"
            style={{ gridTemplateColumns: "repeat(4, 54px)" }}
          >
            {(["all", "ssh", "rdp", "vnc"] as const).map((value) => (
              <button
                className={cx(typeFilter === value && "selected")}
                key={value}
                onClick={() => setTypeFilter(value)}
                type="button"
              >
                {value.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="search-field">
            <Search size={15} />
            <input
              aria-label="Search hosts"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search hosts..."
              value={query}
            />
          </div>
          <button
            aria-label="Refresh hosts"
            className="icon-button"
            onClick={onRefresh}
            type="button"
          >
            <RefreshCw size={15} />
          </button>
          {canManageHosts(role) && (
            <>
              <button
                className="secondary-button"
                onClick={() => setHostsTab("transfer")}
                type="button"
              >
                <FileUp size={15} />
                Import / Export
              </button>
              <button
                className="primary-button"
                onClick={() => setAdding(true)}
                type="button"
              >
                <Plus size={15} />
                Add Host
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Sits between the header and the rows rather than up in .table-tools:
          the count only means anything next to the checkboxes it counts, and the
          header is already carrying five controls. */}
      {canManageHosts(role) && !loading && hosts.length > 0 && (
        <div className={cx("host-bulk", selectedIds.length > 0 && "has-selection")}>
          {selectedIds.length > 0 ? (
            <span className="host-bulk-count">
              <Check size={14} />
              <strong>{selectedIds.length} selected</strong>
              <button
                className="host-bulk-clear"
                onClick={() => setSelectedIds([])}
                type="button"
              >
                Clear
              </button>
            </span>
          ) : (
            <span className="host-bulk-hint">Tick hosts to export only those.</span>
          )}
          <span className="host-bulk-spacer" />
          <span className="host-bulk-label">
            <Download size={14} />
            {exportLabel}
          </span>
          <span className="host-bulk-formats">
            {HOST_EXPORT_FORMATS.map((option) => (
              // Plain anchors: the download is a direct navigation so the browser
              // streams the file instead of us buffering it into a blob.
              <a
                className="host-bulk-format"
                download
                href={consoleApi.hostExportUrl(option.value, selectedIds)}
                key={option.value}
                title={option.hint}
              >
                {option.label}
              </a>
            ))}
          </span>
        </div>
      )}

      {/* Workspaces sit above the table, not below it: their whole value is being
          one click from a set of terminals, and a launcher you have to scroll
          past the estate to find is not that. Hidden from auditors, who cannot
          open a session at all. */}
      {canOpenSession(role) && (
        <div className="hw-block">
          <div className="hw-head">
            <span className="hw-title">
              <Layers size={14} />
              Workspaces
              {workspaces.length > 0 && <em>{workspaces.length}</em>}
            </span>
            <span className="hw-hint">
              {selectedIds.length > 0
                ? `Save the ${selectedIds.length} ticked hosts as a set you can open in one action.`
                : "Saved sets of hosts, opened as terminals together. Tick hosts below to make one."}
            </span>
            <button
              className="hw-save"
              disabled={selectedIds.length === 0}
              onClick={() => setSavingWorkspace(true)}
              title={
                selectedIds.length === 0
                  ? "Tick the hosts you want in the workspace first."
                  : undefined
              }
              type="button"
            >
              <Plus size={14} />
              {selectedIds.length > 0 ? `Save ${selectedIds.length} selected` : "Save selection"}
            </button>
          </div>

          {workspaceError && <div className="error-banner">{workspaceError}</div>}

          {workspacesLoading ? (
            <div className="hw-empty">Loading workspaces…</div>
          ) : workspaces.length === 0 ? (
            <div className="hw-empty">
              No workspaces yet — tick a few hosts and save them as one.
            </div>
          ) : (
            <ul className="hw-list">
              {workspaces.map((workspace) => {
                const live = liveHostIds(workspace);
                const missing = workspace.hostIds.length - live.length;
                return (
                  <li className="hw-item" key={workspace.id}>
                    <div className="hw-item-main">
                      <strong>{workspace.name}</strong>
                      <small>
                        {live.length} host{live.length === 1 ? "" : "s"}
                        {/* Surfaced rather than hidden: a workspace quietly
                            opening fewer tabs than it used to is exactly the
                            kind of drift someone needs to know about. */}
                        {missing > 0 && <span className="hw-missing">{missing} unavailable</span>}
                        {workspace.description ? ` · ${workspace.description}` : ""}
                      </small>
                    </div>
                    <div className="row-actions">
                      <button
                        className="hw-open"
                        disabled={live.length === 0}
                        onClick={() => openWorkspace(workspace)}
                        type="button"
                      >
                        <SquareTerminal size={14} />
                        Open terminals
                      </button>
                      <button
                        aria-label={`Rename ${workspace.name}`}
                        className="icon-button compact"
                        onClick={() => setEditingWorkspace(workspace)}
                        title="Rename workspace"
                        type="button"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        aria-label={`Delete ${workspace.name}`}
                        className="icon-button compact"
                        onClick={() => setDeletingWorkspace(workspace)}
                        title="Delete workspace"
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </>
      ) : filtered.length === 0 ? (
        <EmptyState
          hint={
            hosts.length === 0
              ? "Add your first host to open a terminal."
              : "No host matches the current filter."
          }
          icon={<Inbox size={22} />}
          title={hosts.length === 0 ? "No hosts yet" : "Nothing found"}
        />
      ) : (
        // "has-select" widens the grid by one track; without it the table keeps
        // its original six columns for roles that cannot export.
        <div className={cx("host-table", canManageHosts(role) && "has-select")}>
          <div className="host-row table-head">
            {canManageHosts(role) && (
              <span className="host-select-cell">
                <input
                  aria-label={allVisibleSelected ? "Select no hosts" : "Select all hosts"}
                  checked={allVisibleSelected}
                  className="host-select-box"
                  onChange={toggleAllVisible}
                  ref={(node) => {
                    // React exposes no prop for the tri-state, so the partial
                    // "some but not all" mark has to be set on the DOM node.
                    if (node) node.indeterminate = someVisibleSelected;
                  }}
                  type="checkbox"
                />
              </span>
            )}
            <span>Name</span>
            <span>Address</span>
            <span>Environment</span>
            <span>Health</span>
            <span>Last session</span>
            <span />
          </div>
          {filtered.map((host) => {
            const Icon = protocolIcons[host.type] ?? SquareTerminal;
            const selected = selectedSet.has(host.id);
            return (
              <div className={cx("host-row", selected && "is-selected")} key={host.id}>
                {canManageHosts(role) && (
                  <div
                    className="host-select-cell"
                    // Rows carry their own click affordances (and the cursor to
                    // match), so ticking a box must not also open the host.
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      aria-label={`Select ${host.name}`}
                      checked={selected}
                      className="host-select-box"
                      onChange={() => toggleSelected(host.id)}
                      onClick={(event) => event.stopPropagation()}
                      type="checkbox"
                    />
                  </div>
                )}
                <div className="host-title">
                  {host.isLocal ? (
                    <MonitorSmartphone className="protocol-icon ssh" size={16} />
                  ) : (
                    <Icon className={cx("protocol-icon", host.type)} size={16} />
                  )}
                  <div>
                    <strong>
                      {host.name}
                      {host.isLocal && <span className="host-builtin">Built-in</span>}
                    </strong>
                    <small>
                      {host.isLocal ? "Shell + files on this machine" : host.type.toUpperCase()}
                      {host.group ? ` · ${host.group}` : ""}
                      {host.tags.length > 0 ? ` · ${host.tags.join(", ")}` : ""}
                    </small>
                  </div>
                </div>
                <span>{host.isLocal ? "No credential needed" : `${host.address}:${host.port}`}</span>
                <span className={cx("env-pill", host.environment)}>
                  {host.environment}
                </span>
                <span className={cx("health-badge", host.health)}>
                  {host.health}
                </span>
                <span className="data-muted">
                  {host.lastSessionAt ? relativeTime(host.lastSessionAt) : "Never"}
                </span>
                <div className="row-actions">
                  {canOpenSession(role) && (
                    <button
                      aria-label={`Connect to ${host.name}`}
                      className="icon-button compact"
                      onClick={() =>
                        onLaunch(host, host.type === "ssh" ? "ssh" : "rdp")
                      }
                      title="Open session"
                      type="button"
                    >
                      <Play size={14} />
                    </button>
                  )}
                  {/* The built-in local host has no address to edit and the API
                      refuses to delete it, so it gets neither control. */}
                  {canManageHosts(role) && !host.isLocal && (
                    <button
                      aria-label={`Edit ${host.name}`}
                      className="icon-button compact"
                      onClick={() => setEditingHost(host)}
                      title="Edit host"
                      type="button"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  {canManageHosts(role) && !host.isLocal && (
                    <button
                      aria-label={`Delete ${host.name}`}
                      className="icon-button compact"
                      onClick={() => onDelete(host)}
                      title="Delete host"
                      type="button"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Drawer
        onClose={() => setAdding(false)}
        open={adding}
        subtitle="Connection details are stored per organization."
        title="Add host"
      >
        <form className="form-grid" onSubmit={submit}>
          <label>
            Name
            <input name="name" placeholder="edge-01" required />
          </label>
          <label>
            Type
            <select defaultValue="ssh" name="type">
              <option value="ssh">SSH</option>
              <option value="rdp">RDP</option>
              <option value="vnc">VNC</option>
            </select>
          </label>
          <label>
            Address
            <input
              name="address"
              placeholder="203.0.113.10 or host.example.com"
              required
            />
          </label>
          <label>
            Port
            <input
              defaultValue={22}
              name="port"
              type="number"
              min={1}
              max={65535}
            />
          </label>
          <label>
            Username
            <input name="username" placeholder="root" />
          </label>
          <label>
            Environment
            <select defaultValue="development" name="environment">
              <option value="production">Production</option>
              <option value="staging">Staging</option>
              <option value="development">Development</option>
            </select>
          </label>
          <label>
            Group
            <input name="group" placeholder="web-servers" />
          </label>
          <label>
            Tags (comma separated)
            <input name="tags" placeholder="nginx, dhaka-dc" />
          </label>
          <label className="span-two">
            Credential (from Vault)
            <select defaultValue="" name="credentialId">
              <option value="">— None (attach later) —</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} · {credential.kind.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions span-two">
            <SubmitButton busy={busy} label="Add Host" />
          </div>
        </form>
      </Drawer>

      <Drawer
        onClose={() => setEditingHost(null)}
        open={editingHost !== null}
        subtitle="Update connection details or the attached vault credential."
        title={editingHost ? `Edit ${editingHost.name}` : "Edit host"}
      >
        {editingHost && (
          <form className="form-grid" key={editingHost.id} onSubmit={submitEdit}>
            <label>
              Name
              <input defaultValue={editingHost.name} name="name" placeholder="edge-01" required />
            </label>
            <label>
              Type
              <select defaultValue={editingHost.type} name="type">
                <option value="ssh">SSH</option>
                <option value="rdp">RDP</option>
                <option value="vnc">VNC</option>
              </select>
            </label>
            <label>
              Address
              <input
                defaultValue={editingHost.address}
                name="address"
                placeholder="203.0.113.10 or host.example.com"
                required
              />
            </label>
            <label>
              Port
              <input
                defaultValue={editingHost.port}
                name="port"
                type="number"
                min={1}
                max={65535}
              />
            </label>
            <label>
              Username
              <input defaultValue={editingHost.username ?? ""} name="username" placeholder="root" />
            </label>
            <label>
              Environment
              <select defaultValue={editingHost.environment} name="environment">
                <option value="production">Production</option>
                <option value="staging">Staging</option>
                <option value="development">Development</option>
              </select>
            </label>
            <label>
              Group
              <input defaultValue={editingHost.group ?? ""} name="group" placeholder="web-servers" />
            </label>
            <label>
              Tags (comma separated)
              <input defaultValue={editingHost.tags.join(", ")} name="tags" placeholder="nginx, dhaka-dc" />
            </label>
            <label className="span-two">
              Credential (from Vault)
              <select defaultValue={credentialForHost(editingHost.id)?.id ?? ""} name="credentialId">
                <option value="">— None —</option>
                {credentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.name} · {credential.kind.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions span-two">
              <SubmitButton busy={busy} label="Save Changes" />
            </div>
          </form>
        )}
      </Drawer>

      <Drawer
        onClose={() => setSavingWorkspace(false)}
        open={savingWorkspace}
        subtitle={`${selectedIds.length} host${selectedIds.length === 1 ? "" : "s"} will be saved in the order you ticked them.`}
        title="Save workspace"
      >
        <form className="form-grid" onSubmit={submitWorkspace}>
          <label className="span-two">
            Name
            <input name="name" placeholder="prod web tier" required />
          </label>
          <label className="span-two">
            Note (optional)
            <input name="description" placeholder="Deploy order: canary first" />
          </label>
          <div className="hw-preview span-two">
            {selectedIds.map((id) => {
              const host = hosts.find((item) => item.id === id);
              return (
                <span className="hw-chip" key={id}>
                  {host?.name ?? id}
                </span>
              );
            })}
          </div>
          <div className="form-actions span-two">
            <SubmitButton busy={workspaceBusy} label="Save Workspace" />
          </div>
        </form>
      </Drawer>

      <Drawer
        onClose={() => setEditingWorkspace(null)}
        open={editingWorkspace !== null}
        subtitle="Rename it, or point it at the hosts you have ticked now."
        title={editingWorkspace ? `Edit ${editingWorkspace.name}` : "Edit workspace"}
      >
        {editingWorkspace && (
          <form className="form-grid" key={editingWorkspace.id} onSubmit={submitWorkspaceEdit}>
            <label className="span-two">
              Name
              <input defaultValue={editingWorkspace.name} name="name" required />
            </label>
            <label className="span-two">
              Note (optional)
              <input defaultValue={editingWorkspace.description ?? ""} name="description" />
            </label>
            {/* Only offered when there is a selection to swap in — an unchecked
                box that could not do anything is just a dead control. */}
            {selectedIds.length > 0 && (
              <label className="hw-replace span-two">
                <input name="replaceHosts" type="checkbox" />
                <span>
                  Replace its {editingWorkspace.hostIds.length} host
                  {editingWorkspace.hostIds.length === 1 ? "" : "s"} with the {selectedIds.length}{" "}
                  ticked in the table
                </span>
              </label>
            )}
            <div className="form-actions span-two">
              <SubmitButton busy={workspaceBusy} label="Save Changes" />
            </div>
          </form>
        )}
      </Drawer>

      <ConfirmModal
        busy={workspaceBusy}
        message={
          deletingWorkspace ? (
            <>
              Delete workspace <strong>{deletingWorkspace.name}</strong>? The hosts in it are not
              touched — only the saved grouping goes away.
            </>
          ) : (
            ""
          )
        }
        onClose={() => setDeletingWorkspace(null)}
        onConfirm={() => void confirmWorkspaceDelete()}
        open={deletingWorkspace !== null}
        title="Delete workspace"
      />
    </section>
  );
}

/* ---------- Vault ---------- */

export function VaultView({
  credentials,
  hosts,
  role,
  loading,
  onChanged,
  notify,
}: {
  credentials: CredentialSummary[];
  hosts: Host[];
  role: Role;
  loading: boolean;
  onChanged: () => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CredentialSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<CredentialSummary | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const manage = canManageHosts(role);
  const hostName = (id: string) =>
    hosts.find((host) => host.id === id)?.name ?? "unknown";

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await consoleApi.createCredential({
        name: String(data.get("name") ?? ""),
        kind: String(data.get("kind") ?? "password"),
        secret: String(data.get("secret") ?? ""),
        attachedHostIds: data.getAll("attachedHostIds").map(String),
      });
      notify("Credential stored in the encrypted vault.", "success");
      setAdding(false);
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not save credential.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await consoleApi.updateCredential(editing.id, {
        name: String(data.get("name") ?? ""),
        attachedHostIds: data.getAll("attachedHostIds").map(String),
      });
      notify("Credential updated.", "success");
      setEditing(null);
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not update credential.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setRemovingBusy(true);
    try {
      await consoleApi.deleteCredential(deleting.id);
      notify("Credential deleted.", "success");
      setDeleting(null);
      onChanged();
    } catch (err) {
      const message =
        err instanceof Error && err.message === "credential_in_use"
          ? "This credential is attached to a host. Detach it first, then delete."
          : err instanceof Error
            ? err.message
            : "Could not delete credential.";
      notify(message, "error");
    } finally {
      setRemovingBusy(false);
    }
  }

  const columns: DataColumn<CredentialSummary>[] = [
    {
      key: "name",
      header: "Name",
      width: "minmax(160px, 1.2fr)",
      sortValue: (credential) => credential.name.toLowerCase(),
      render: (credential) => (
        <div className="data-identity">
          <span className="data-icon">
            <KeyRound size={15} />
          </span>
          <strong>{credential.name}</strong>
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      width: "130px",
      sortValue: (credential) => credential.kind,
      render: (credential) => <span className="env-pill">{credential.kind.replace("_", " ")}</span>,
    },
    {
      key: "hosts",
      header: "Hosts",
      width: "minmax(140px, 1fr)",
      render: (credential) => (
        <span className="data-muted">
          {credential.attachedHostIds.length > 0
            ? credential.attachedHostIds.map(hostName).join(", ")
            : "Not attached"}
        </span>
      ),
    },
    {
      key: "lastUsed",
      header: "Last used",
      width: "minmax(110px, 0.7fr)",
      sortValue: (credential) => (credential.lastUsedAt ? new Date(credential.lastUsedAt).getTime() : 0),
      render: (credential) => <span className="data-muted">{relativeTime(credential.lastUsedAt)}</span>,
    },
    {
      key: "updated",
      header: "Updated",
      width: "minmax(110px, 0.7fr)",
      sortValue: (credential) => new Date(credential.updatedAt).getTime(),
      render: (credential) => <span className="data-muted">{shortDate(credential.updatedAt)}</span>,
    },
    {
      key: "created",
      header: "Created",
      width: "minmax(110px, 0.7fr)",
      sortValue: (credential) => new Date(credential.createdAt).getTime(),
      render: (credential) => <span className="data-muted">{shortDate(credential.createdAt)}</span>,
    },
  ];

  if (manage) {
    columns.push({
      key: "actions",
      header: "Actions",
      width: "96px",
      align: "end",
      render: (credential) => (
        <div className="row-actions">
          <button
            aria-label={`Edit ${credential.name}`}
            className="icon-button compact"
            onClick={() => setEditing(credential)}
            title="Edit credential"
            type="button"
          >
            <Pencil size={14} />
          </button>
          <button
            aria-label={`Delete ${credential.name}`}
            className="icon-button compact danger"
            onClick={() =>
              credential.attachedHostIds.length > 0
                ? notify(
                    `"${credential.name}" is attached to ${credential.attachedHostIds.length} host${credential.attachedHostIds.length > 1 ? "s" : ""}. Detach it from every host before deleting.`,
                    "error",
                  )
                : setDeleting(credential)
            }
            title={
              credential.attachedHostIds.length > 0
                ? "Detach from all hosts before deleting"
                : "Delete credential"
            }
            type="button"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    });
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Credential Vault</h2>
          <p>
            Secrets are encrypted server-side and never returned after save.
          </p>
        </div>
      </div>
      <DataTable
        columns={columns}
        defaultSort={{ key: "name", dir: "asc" }}
        empty={{
          icon: <KeyRound size={22} />,
          title: "Vault is empty",
          hint: "Store a password or SSH key so sessions can connect without exposing secrets.",
        }}
        loading={loading}
        rightTools={
          manage ? (
            <button className="primary-button" onClick={() => setAdding(true)} type="button">
              <Plus size={15} />
              Add Credential
            </button>
          ) : undefined
        }
        rowKey={(credential) => credential.id}
        rows={credentials}
        searchPlaceholder="Search credentials…"
        searchText={(credential) =>
          `${credential.name} ${credential.kind} ${credential.attachedHostIds.map(hostName).join(" ")}`
        }
      />

      <ConfirmModal
        busy={removingBusy}
        confirmLabel="Delete credential"
        message={
          <>
            Delete credential <strong>{deleting?.name}</strong>? Hosts using it will need a new one.
          </>
        }
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        open={deleting !== null}
        title="Delete credential"
      />

      <Drawer
        onClose={() => setAdding(false)}
        open={adding}
        subtitle="The secret is encrypted with AES-256-GCM before it is stored."
        title="Add credential"
      >
        <form className="form-grid" onSubmit={submitCreate}>
          <label>
            Name
            <input name="name" placeholder="deploy key" required />
          </label>
          <label>
            Kind
            <select defaultValue="password" name="kind">
              <option value="password">Password</option>
              <option value="ssh_key">SSH private key</option>
              <option value="rdp_password">RDP password</option>
            </select>
          </label>
          <label className="span-two">
            Secret
            <textarea
              name="secret"
              placeholder="Password or private key contents"
              required
            />
          </label>
          <label className="span-two">
            Attach to hosts
            <select
              multiple
              name="attachedHostIds"
              size={Math.min(5, Math.max(2, hosts.length))}
            >
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name} ({host.address})
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions span-two">
            <SubmitButton busy={busy} label="Save Credential" />
          </div>
        </form>
      </Drawer>

      <Drawer
        onClose={() => setEditing(null)}
        open={editing !== null}
        subtitle="Rename the credential or change which hosts it is attached to. Rotate the secret from a session."
        title="Edit credential"
      >
        {editing && (
          <form className="form-grid" onSubmit={submitEdit}>
            <label className="span-two">
              Name
              <input defaultValue={editing.name} name="name" placeholder="deploy key" required />
            </label>
            <label className="span-two">
              Attach to hosts
              <select
                defaultValue={editing.attachedHostIds}
                multiple
                name="attachedHostIds"
                size={Math.min(5, Math.max(2, hosts.length))}
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name} ({host.address})
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions span-two">
              <button className="primary-button" disabled={busy} type="submit">
                {busy ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                Save Changes
              </button>
            </div>
          </form>
        )}
      </Drawer>
    </section>
  );
}

/* ---------- Snippets ---------- */

/** Snippet scopes, plus "all". Mirrors Snippet["scope"] in @onshell/shared. */
type ScopeFilter = "all" | Snippet["scope"];

const SCOPE_FILTERS: Array<{ value: ScopeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "personal", label: "Personal" },
  { value: "team", label: "Team" },
  { value: "host", label: "Host" },
];

export function SnippetsView({
  snippets,
  loading,
  hasActiveTerminal,
  onRun,
  onChanged,
  notify,
}: {
  snippets: Snippet[];
  loading: boolean;
  hasActiveTerminal: boolean;
  onRun: (command: string) => void;
  onChanged: () => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");

  // Filtering client-side is fine here: snippets are a small, already-loaded set
  // scoped to one organization, so there is nothing to gain from a round-trip.
  const visibleSnippets = useMemo(
    () =>
      scopeFilter === "all"
        ? snippets
        : snippets.filter((snippet) => snippet.scope === scopeFilter),
    [snippets, scopeFilter],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await consoleApi.createSnippet({
        name: String(data.get("name") ?? ""),
        command: String(data.get("command") ?? ""),
        scope: String(data.get("scope") ?? "personal"),
      });
      notify("Snippet saved.", "success");
      setAdding(false);
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not save snippet.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy(snippet: Snippet) {
    try {
      await navigator.clipboard.writeText(snippet.command);
      notify("Command copied to clipboard.", "success");
    } catch {
      notify("Clipboard is not available.", "error");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setRemovingBusy(true);
    try {
      await consoleApi.deleteSnippet(deleting.id);
      notify("Snippet deleted.", "success");
      setDeleting(null);
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not delete snippet.",
        "error",
      );
    } finally {
      setRemovingBusy(false);
    }
  }

  const columns: DataColumn<Snippet>[] = [
    {
      key: "name",
      header: "Name",
      width: "minmax(160px, 1fr)",
      sortValue: (snippet) => snippet.name.toLowerCase(),
      render: (snippet) => (
        <div className="data-identity">
          <span className="data-icon">
            <Braces size={15} />
          </span>
          <strong>{snippet.name}</strong>
        </div>
      ),
    },
    {
      key: "command",
      header: "Command",
      width: "minmax(220px, 2fr)",
      render: (snippet) => <span className="data-mono">{snippet.command}</span>,
    },
    {
      key: "scope",
      header: "Scope",
      width: "110px",
      sortValue: (snippet) => snippet.scope,
      render: (snippet) => <span className="env-pill">{snippet.scope}</span>,
    },
    {
      key: "updated",
      header: "Updated",
      width: "minmax(120px, 0.7fr)",
      sortValue: (snippet) => new Date(snippet.updatedAt).getTime(),
      render: (snippet) => <span className="data-muted">{shortDate(snippet.updatedAt)}</span>,
    },
    {
      key: "actions",
      header: "Actions",
      width: "128px",
      align: "end",
      render: (snippet) => (
        <div className="row-actions">
          <button
            aria-label={`Copy ${snippet.name}`}
            className="icon-button compact"
            onClick={() => copy(snippet)}
            title="Copy command"
            type="button"
          >
            <Copy size={14} />
          </button>
          <button
            aria-label={`Run ${snippet.name}`}
            className="icon-button compact"
            disabled={!hasActiveTerminal}
            onClick={() => onRun(snippet.command)}
            title={hasActiveTerminal ? "Run in active terminal" : "Open a terminal first"}
            type="button"
          >
            <Play size={14} />
          </button>
          <button
            aria-label={`Delete ${snippet.name}`}
            className="icon-button compact danger"
            onClick={() => setDeleting(snippet)}
            title="Delete snippet"
            type="button"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Snippets</h2>
          <p>
            Reusable commands for the whole team. Run them straight into the
            active terminal.
          </p>
        </div>
      </div>
      <DataTable
        columns={columns}
        defaultSort={{ key: "name", dir: "asc" }}
        empty={{
          icon: <Braces size={22} />,
          title: scopeFilter === "all" ? "No snippets yet" : `No ${scopeFilter} snippets`,
          hint:
            scopeFilter === "all"
              ? "Save the commands you run on every server."
              : "Try a different scope, or save a new snippet here.",
        }}
        leftTools={
          <div
            aria-label="Filter by scope"
            className="segmented"
            role="group"
            style={{ gridTemplateColumns: `repeat(${SCOPE_FILTERS.length}, minmax(64px, auto))` }}
          >
            {SCOPE_FILTERS.map((option) => (
              <button
                aria-pressed={scopeFilter === option.value}
                className={cx(scopeFilter === option.value && "selected")}
                key={option.value}
                onClick={() => setScopeFilter(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        }
        loading={loading}
        rightTools={
          <button className="primary-button" onClick={() => setAdding(true)} type="button">
            <Plus size={15} />
            New Snippet
          </button>
        }
        rowKey={(snippet) => snippet.id}
        rows={visibleSnippets}
        searchPlaceholder="Search snippets…"
        searchText={(snippet) => `${snippet.name} ${snippet.command} ${snippet.scope}`}
      />

      <ConfirmModal
        busy={removingBusy}
        message={
          <>
            Delete snippet <strong>{deleting?.name}</strong>? This cannot be undone.
          </>
        }
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        open={deleting !== null}
        title="Delete snippet"
      />

      <Drawer
        onClose={() => setAdding(false)}
        open={adding}
        title="New snippet"
      >
        <form className="form-grid" onSubmit={submit}>
          <label className="span-two">
            Name
            <input name="name" placeholder="Restart nginx" required />
          </label>
          <label className="span-two">
            Command
            <textarea
              name="command"
              placeholder="sudo systemctl restart nginx"
              required
            />
          </label>
          <label>
            Scope
            <select defaultValue="team" name="scope">
              <option value="personal">Personal</option>
              <option value="team">Team</option>
            </select>
          </label>
          <div className="form-actions span-two">
            <SubmitButton busy={busy} label="Save Snippet" />
          </div>
        </form>
      </Drawer>
    </section>
  );
}

/* ---------- My computers ---------- */

const PLATFORM_LABELS: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

/** Whole minutes left on a pairing code, floored, never negative. */
function minutesUntil(iso: string) {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 60_000));
}

export function AgentsView({
  devices,
  loading,
  role,
  onChanged,
  notify,
}: {
  devices: AgentDevice[];
  loading: boolean;
  role: Role;
  onChanged: () => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<AgentDevice | null>(null);
  const [removing, setRemoving] = useState<AgentDevice | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const manage = canManageHosts(role);

  async function generateCode() {
    setBusy(true);
    try {
      setCode(await consoleApi.createAgentPairingCode());
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not create a pairing code.", "error");
    } finally {
      setBusy(false);
    }
  }

  function openPairing() {
    // A fresh code every time the drawer opens: the previous one may already be
    // used or expired, and showing a dead code is worse than showing none.
    setCode(null);
    setPairing(true);
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      notify("Pairing code copied.", "success");
    } catch {
      notify("Clipboard is not available.", "error");
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    setActionBusy(true);
    try {
      await consoleApi.revokeAgent(revoking.id);
      notify(`${revoking.name} can no longer connect.`, "success");
      setRevoking(null);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not revoke this machine.", "error");
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setActionBusy(true);
    try {
      await consoleApi.deleteAgent(removing.id);
      notify(`${removing.name} was removed.`, "success");
      setRemoving(null);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not remove this machine.", "error");
    } finally {
      setActionBusy(false);
    }
  }

  const columns: DataColumn<AgentDevice>[] = [
    {
      key: "name",
      header: "Machine",
      width: "minmax(180px, 1.4fr)",
      sortValue: (device) => device.name.toLowerCase(),
      render: (device) => (
        <div className="data-identity">
          <span className="data-icon">
            <Laptop size={15} />
          </span>
          <div>
            <strong>{device.name}</strong>
            {device.hostname && device.hostname !== device.name && (
              <span className="data-muted"> {device.hostname}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "130px",
      sortValue: (device) => (device.revokedAt ? 2 : device.online ? 0 : 1),
      render: (device) =>
        device.revokedAt ? (
          <span className="health-badge offline">Revoked</span>
        ) : device.online ? (
          <span className="health-badge online">Connected</span>
        ) : (
          <span className="health-badge degraded">Offline</span>
        ),
    },
    {
      key: "platform",
      header: "System",
      width: "minmax(130px, 0.9fr)",
      sortValue: (device) => device.platform,
      render: (device) => (
        <span className="data-muted">
          {PLATFORM_LABELS[device.platform] ?? device.platform} · {device.arch}
        </span>
      ),
    },
    {
      key: "agentVersion",
      header: "Agent",
      width: "100px",
      render: (device) => <span className="data-mono">{device.agentVersion ?? "—"}</span>,
    },
    {
      key: "lastSeen",
      header: "Last seen",
      width: "minmax(120px, 0.8fr)",
      sortValue: (device) => (device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0),
      render: (device) => (
        <span className="data-muted">{device.online ? "Now" : relativeTime(device.lastSeenAt)}</span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      width: "104px",
      align: "end",
      render: (device) => (
        <div className="row-actions">
          {manage && !device.revokedAt && (
            <button
              aria-label={`Revoke ${device.name}`}
              className="icon-button compact danger"
              onClick={() => setRevoking(device)}
              title="Revoke access"
              type="button"
            >
              <ShieldCheck size={14} />
            </button>
          )}
          {manage && (
            <button
              aria-label={`Remove ${device.name}`}
              className="icon-button compact danger"
              onClick={() => setRemoving(device)}
              title="Remove this machine"
              type="button"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>My computers</h2>
          <p>
            Machines running the Onshell Agent. Once a computer is paired and the
            agent is running, it appears in Hosts and you can open its terminal
            from any browser.
          </p>
        </div>
      </div>

      <DataTable
        columns={columns}
        defaultSort={{ key: "status", dir: "asc" }}
        empty={{
          icon: <Laptop size={22} />,
          title: "No computers paired yet",
          hint: manage
            ? "Pair a computer to open its terminal from anywhere."
            : "Ask an admin to pair a computer with this workspace.",
        }}
        loading={loading}
        rightTools={
          manage ? (
            <button className="primary-button" onClick={openPairing} type="button">
              <Plus size={15} />
              Connect a computer
            </button>
          ) : undefined
        }
        rowKey={(device) => device.id}
        rows={devices}
        searchPlaceholder="Search computers…"
        searchText={(device) => `${device.name} ${device.hostname ?? ""} ${device.platform}`}
      />

      <ConfirmModal
        busy={actionBusy}
        confirmLabel="Revoke access"
        message={
          <>
            Revoke <strong>{revoking?.name}</strong>? The agent on that machine
            will be disconnected and cannot reconnect until it is paired again.
            The machine stays in this list so its history is kept.
          </>
        }
        onClose={() => setRevoking(null)}
        onConfirm={confirmRevoke}
        open={revoking !== null}
        title="Revoke machine"
      />

      <ConfirmModal
        busy={actionBusy}
        confirmLabel="Remove"
        message={
          <>
            Remove <strong>{removing?.name}</strong> and its host entry? Anyone
            with a terminal open on it will be disconnected. This cannot be
            undone.
          </>
        }
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemove}
        open={removing !== null}
        title="Remove machine"
      />

      <Drawer onClose={() => setPairing(false)} open={pairing} title="Connect a computer">
        <div className="form-grid">
          <div className="span-two">
            <p className="data-muted">
              A browser cannot open a terminal on your computer by itself. Install
              the Onshell Agent on the machine you want to reach, then pair it with
              the code below.
            </p>
            {/* The step that used to be missing: this drawer named a command
                without ever saying where the program comes from. */}
            <div className="form-actions">
              <a className="secondary-button" href="/download" rel="noreferrer" target="_blank">
                <Download size={15} />
                Get the agent for Windows, macOS, or Linux
              </a>
            </div>
          </div>

          {code ? (
            <div className="span-two">
              <p>
                <strong>1.</strong> On that computer, run:
              </p>
              {/* The exact command the downloaded build answers to. There is no
                  installer yet, so `onshell-agent` is not on anyone's PATH. */}
              <p className="data-mono">node onshell-agent.cjs pair {code.code}</p>
              <p className="data-muted">
                This code works once and expires in {minutesUntil(code.expiresAt)}{" "}
                minute{minutesUntil(code.expiresAt) === 1 ? "" : "s"}.
              </p>
              <p>
                <strong>2.</strong> Then start it with{" "}
                <span className="data-mono">node onshell-agent.cjs run</span>. The machine appears here as
                Connected.
              </p>
              <div className="form-actions">
                <button className="secondary-button" onClick={copyCode} type="button">
                  <Copy size={15} />
                  Copy code
                </button>
                <button className="secondary-button" disabled={busy} onClick={generateCode} type="button">
                  {busy ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                  New code
                </button>
              </div>
            </div>
          ) : (
            <div className="span-two">
              <p className="data-muted">
                The code is shown once and is valid for ten minutes.
              </p>
              <div className="form-actions">
                <button className="primary-button" disabled={busy} onClick={generateCode} type="button">
                  {busy ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
                  Generate pairing code
                </button>
              </div>
            </div>
          )}

          <div className="span-two">
            <p className="data-muted">
              While the agent runs, people in this workspace with access to that
              host can open a terminal on it with your account&apos;s privileges.
              Stop the agent to end that at any time.
            </p>
          </div>
        </div>
      </Drawer>
    </section>
  );
}

/* ---------- Team ---------- */

type TeamTab = "members" | "invitations";

/** Compact label for the host-access column and the drawer's summary line. */
function hostAccessLabel(access: MemberHostAccess | undefined) {
  if (access?.allHosts) return "All hosts";
  const count = access?.hostIds.length ?? 0;
  if (count === 0) return "No hosts";
  return `${count} host${count === 1 ? "" : "s"}`;
}

export function TeamView({
  members,
  invitations,
  hosts,
  currentUser,
  loading,
  onChanged,
  notify,
}: {
  members: TeamMember[];
  invitations: PendingInvitation[];
  hosts: Host[];
  currentUser: User;
  loading: boolean;
  onChanged: () => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  /**
   * Set when an invitation was created but the email could not be delivered
   * (usually SMTP is not enabled yet). Holds the link so it can be shared by
   * hand instead of the invite silently going nowhere.
   */
  const [undeliveredInvite, setUndeliveredInvite] = useState<{ email: string; acceptUrl: string } | null>(null);
  const [removingMember, setRemovingMember] = useState<TeamMember | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<PendingInvitation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [tab, setTab] = useState<TeamTab>("members");
  const [accessMember, setAccessMember] = useState<TeamMember | null>(null);
  const [accessAllHosts, setAccessAllHosts] = useState(false);
  const [accessHostIds, setAccessHostIds] = useState<string[]>([]);
  const manager = canManageUsers(currentUser.role);

  const teamTabs: Array<{ value: TeamTab; label: string }> = [
    { value: "members", label: `Members (${members.length})` },
    { value: "invitations", label: `Pending invitations (${invitations.length})` },
  ];

  function openHostAccess(member: TeamMember) {
    setAccessMember(member);
    setAccessAllHosts(member.hostAccess?.allHosts ?? false);
    setAccessHostIds(member.hostAccess?.hostIds ?? []);
  }

  async function saveHostAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessMember) return;
    setBusy(true);
    try {
      await consoleApi.setMemberHostAccess(accessMember.id, {
        allHosts: accessAllHosts,
        hostIds: accessAllHosts ? [] : accessHostIds,
      });
      notify(`Host access updated for ${accessMember.name}.`, "success");
      setAccessMember(null);
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not update host access.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // Roving focus across the tablist, which is what makes a tab strip usable
  // without a mouse.
  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = teamTabs.findIndex((option) => option.value === tab);
    const next = event.key === "ArrowRight" ? index + 1 : index - 1;
    setTab(teamTabs[(next + teamTabs.length) % teamTabs.length].value);
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "");
    setBusy(true);
    try {
      const result = await consoleApi.invite({
        email,
        role: String(data.get("role") ?? "developer") as Role,
      });

      if (result.emailSent) {
        notify(`Invitation emailed to ${email}.`, "success");
        setUndeliveredInvite(null);
        form.reset();
        setInviting(false);
      } else {
        // The invitation exists and is valid — only delivery failed. Keep the
        // drawer open and hand the owner the link rather than claiming an email
        // was sent that never left the server.
        setUndeliveredInvite({ email, acceptUrl: result.acceptUrl });
        notify("Invitation created, but email could not be sent.", "error");
      }

      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not send invitation.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyAcceptUrl() {
    if (!undeliveredInvite) return;
    try {
      await navigator.clipboard.writeText(undeliveredInvite.acceptUrl);
      notify("Invite link copied.", "success");
    } catch {
      notify("Clipboard is not available — select the link and copy it.", "error");
    }
  }

  async function changeRole(member: TeamMember, role: Role) {
    try {
      await consoleApi.changeMemberRole(member.id, role);
      notify(`${member.name} is now ${role}.`, "success");
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not change role.",
        "error",
      );
    }
  }

  async function confirmRemoveMember() {
    if (!removingMember) return;
    setConfirmBusy(true);
    try {
      await consoleApi.removeMember(removingMember.id);
      notify("Member removed.", "success");
      setRemovingMember(null);
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not remove member.",
        "error",
      );
    } finally {
      setConfirmBusy(false);
    }
  }

  async function confirmRevoke() {
    if (!revokingInvite) return;
    setConfirmBusy(true);
    try {
      await consoleApi.revokeInvitation(revokingInvite.id);
      notify("Invitation revoked.", "success");
      setRevokingInvite(null);
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not revoke invitation.",
        "error",
      );
    } finally {
      setConfirmBusy(false);
    }
  }

  const memberColumns: DataColumn<TeamMember>[] = [
    {
      key: "member",
      header: "Member",
      width: "minmax(220px, 1.6fr)",
      sortValue: (member) => member.name.toLowerCase(),
      render: (member) => (
        <div className="data-identity">
          <TableAvatar name={member.name} url={member.avatarUrl} />
          <div className="data-identity-text">
            <strong>
              {member.name}
              {member.id === currentUser.id ? " (you)" : ""}
            </strong>
            <small>{member.email}</small>
          </div>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      width: "150px",
      sortValue: (member) => member.role,
      render: (member) =>
        manager && member.id !== currentUser.id ? (
          <select
            aria-label={`Role for ${member.name}`}
            className="data-inline-select"
            onChange={(event) => changeRole(member, event.target.value as Role)}
            value={member.role}
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        ) : (
          <span className="env-pill">{member.role}</span>
        ),
    },
    {
      key: "hostAccess",
      header: "Host access",
      width: "minmax(150px, 1fr)",
      sortValue: (member) => hostAccessLabel(member.hostAccess),
      render: (member) => {
        const implicit = member.hostAccess?.implicit ?? false;
        const label = hostAccessLabel(member.hostAccess);
        if (!manager) return <span className="data-muted">{label}</span>;
        return (
          <button
            aria-label={`Host access for ${member.name}: ${label}`}
            className="host-access-chip"
            disabled={implicit}
            onClick={() => openHostAccess(member)}
            title={
              implicit
                ? `${member.role}s reach every host in the organization by role, so there is nothing to grant.`
                : `Change which hosts ${member.name} can reach`
            }
            type="button"
          >
            <MonitorUp size={13} />
            {label}
          </button>
        );
      },
    },
    {
      key: "twofa",
      header: "2FA",
      width: "110px",
      sortValue: (member) => (member.twoFactorEnabled ? 1 : 0),
      render: (member) => (
        <span className={cx("env-pill", member.twoFactorEnabled && "development")}>
          {member.twoFactorEnabled ? "2FA on" : "2FA off"}
        </span>
      ),
    },
    {
      key: "joined",
      header: "Joined",
      width: "minmax(120px, 0.7fr)",
      sortValue: (member) => (member.joinedAt ? new Date(member.joinedAt).getTime() : 0),
      render: (member) => <span className="data-muted">{shortDate(member.joinedAt)}</span>,
    },
  ];

  if (manager) {
    memberColumns.push({
      key: "actions",
      header: "Actions",
      width: "80px",
      align: "end",
      render: (member) =>
        member.id !== currentUser.id ? (
          <div className="row-actions">
            <button
              aria-label={`Remove ${member.name}`}
              className="icon-button compact danger"
              onClick={() => setRemovingMember(member)}
              title="Remove member"
              type="button"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <span />
        ),
    });
  }

  const invitationColumns: DataColumn<PendingInvitation>[] = [
    {
      key: "email",
      header: "Email",
      width: "minmax(200px, 1.6fr)",
      sortValue: (invitation) => invitation.email.toLowerCase(),
      render: (invitation) => (
        <div className="data-identity">
          <span className="data-icon">
            <Mail size={15} />
          </span>
          <strong>{invitation.email}</strong>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      width: "130px",
      sortValue: (invitation) => invitation.role,
      render: (invitation) => <span className="env-pill">{invitation.role}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "120px",
      render: () => <span className="session-state pending">pending</span>,
    },
    {
      key: "invited",
      header: "Invited",
      width: "minmax(120px, 0.7fr)",
      sortValue: (invitation) => (invitation.createdAt ? new Date(invitation.createdAt).getTime() : 0),
      render: (invitation) => <span className="data-muted">{shortDate(invitation.createdAt)}</span>,
    },
    {
      key: "expires",
      header: "Expires",
      width: "minmax(120px, 0.7fr)",
      sortValue: (invitation) => (invitation.expiresAt ? new Date(invitation.expiresAt).getTime() : 0),
      render: (invitation) => <span className="data-muted">{shortDate(invitation.expiresAt)}</span>,
    },
    {
      key: "actions",
      header: "Actions",
      width: "80px",
      align: "end",
      render: (invitation) => (
        <div className="row-actions">
          <button
            aria-label={`Revoke invitation for ${invitation.email}`}
            className="icon-button compact danger"
            onClick={() => setRevokingInvite(invitation)}
            title="Revoke invitation"
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="main-column">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Team</h2>
            <p>Roles control what each member can do; host access controls what they can reach.</p>
          </div>
        </div>

        {/* Members and invitations share one area: stacking two tables made the
            page read as two unrelated panels. Only managers see invitations. */}
        {manager ? (
          <>
            <div
              aria-label="Team lists"
              className="segmented team-tabs"
              onKeyDown={moveTab}
              role="tablist"
            >
              {teamTabs.map((option) => (
                <button
                  aria-controls={`team-panel-${option.value}`}
                  aria-selected={tab === option.value}
                  className={cx(tab === option.value && "selected")}
                  id={`team-tab-${option.value}`}
                  key={option.value}
                  onClick={() => setTab(option.value)}
                  role="tab"
                  tabIndex={tab === option.value ? 0 : -1}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>

            {tab === "members" ? (
              <div
                aria-labelledby="team-tab-members"
                id="team-panel-members"
                role="tabpanel"
                tabIndex={0}
              >
                <DataTable
                  columns={memberColumns}
                  defaultSort={{ key: "member", dir: "asc" }}
                  empty={{ icon: <UserRound size={22} />, title: "No members yet" }}
                  loading={loading}
                  rightTools={
                    <button className="primary-button" onClick={() => setInviting(true)} type="button">
                      <UserPlus size={15} />
                      Invite Member
                    </button>
                  }
                  rowKey={(member) => member.id}
                  rows={members}
                  searchPlaceholder="Search members…"
                  searchText={(member) =>
                    `${member.name} ${member.email} ${member.role} ${hostAccessLabel(member.hostAccess)}`
                  }
                />
              </div>
            ) : (
              <div
                aria-labelledby="team-tab-invitations"
                id="team-panel-invitations"
                role="tabpanel"
                tabIndex={0}
              >
                <DataTable
                  columns={invitationColumns}
                  defaultSort={{ key: "invited", dir: "desc" }}
                  empty={{
                    icon: <Mail size={22} />,
                    title: "No pending invitations",
                    hint: "Invite a teammate to see them listed here.",
                  }}
                  loading={loading}
                  rightTools={
                    <button className="primary-button" onClick={() => setInviting(true)} type="button">
                      <UserPlus size={15} />
                      Invite Member
                    </button>
                  }
                  rowKey={(invitation) => invitation.id}
                  rows={invitations}
                  searchPlaceholder="Search invitations…"
                  searchText={(invitation) => `${invitation.email} ${invitation.role}`}
                />
              </div>
            )}
          </>
        ) : (
          <DataTable
            columns={memberColumns}
            defaultSort={{ key: "member", dir: "asc" }}
            empty={{ icon: <UserRound size={22} />, title: "No members yet" }}
            loading={loading}
            rowKey={(member) => member.id}
            rows={members}
            searchPlaceholder="Search members…"
            searchText={(member) => `${member.name} ${member.email} ${member.role}`}
          />
        )}
      </section>

      <Drawer
        onClose={() => setAccessMember(null)}
        open={accessMember !== null}
        subtitle="Members can only see, open and manage the hosts granted to them here."
        title={accessMember ? `Host access — ${accessMember.name}` : "Host access"}
      >
        {accessMember && (
          <form className="form-grid" onSubmit={saveHostAccess}>
            <fieldset className="span-two access-scope">
              <legend>Scope</legend>
              <label className="access-radio">
                <input
                  checked={accessAllHosts}
                  name="hostAccessScope"
                  onChange={() => setAccessAllHosts(true)}
                  type="radio"
                  value="all"
                />
                <span>
                  <strong>All hosts</strong>
                  <small>Every host in this organization, including ones added later.</small>
                </span>
              </label>
              <label className="access-radio">
                <input
                  checked={!accessAllHosts}
                  name="hostAccessScope"
                  onChange={() => setAccessAllHosts(false)}
                  type="radio"
                  value="specific"
                />
                <span>
                  <strong>Specific hosts</strong>
                  <small>Only the hosts selected below.</small>
                </span>
              </label>
            </fieldset>

            <label className="span-two">
              Hosts
              <select
                className="host-access-select"
                disabled={accessAllHosts}
                multiple
                onChange={(event) =>
                  setAccessHostIds(
                    Array.from(event.target.selectedOptions, (option) => option.value),
                  )
                }
                size={Math.min(8, Math.max(3, hosts.length))}
                value={accessHostIds}
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name} ({host.address})
                  </option>
                ))}
              </select>
              <small className="field-note">
                {accessAllHosts
                  ? "All hosts granted — the list above is ignored."
                  : `${accessHostIds.length} of ${hosts.length} host${hosts.length === 1 ? "" : "s"} selected. Hold ⌘/Ctrl or Shift to pick several.`}
              </small>
            </label>

            <div className="form-actions span-two">
              <SubmitButton busy={busy} label="Save Host Access" />
            </div>
          </form>
        )}
      </Drawer>

      <Drawer
        onClose={() => {
          setInviting(false);
          setUndeliveredInvite(null);
        }}
        open={inviting}
        subtitle="They will receive an email link to join this workspace."
        title="Invite member"
      >
        <form className="form-grid" onSubmit={invite}>
          {undeliveredInvite && (
            <div className="invite-fallback span-two" role="status">
              <p className="invite-fallback-title">
                <AlertTriangle aria-hidden="true" size={15} />
                Invitation created, but the email wasn&apos;t sent
              </p>
              <p className="invite-fallback-text">
                Email delivery isn&apos;t configured yet, so <strong>{undeliveredInvite.email}</strong> did not receive
                anything. The invitation is valid for 7 days — send them this link directly, or ask a platform admin to
                enable SMTP in <strong>Admin → Settings → SMTP</strong>.
              </p>
              <div className="invite-fallback-row">
                <input
                  aria-label="Invitation link"
                  onFocus={(event) => event.target.select()}
                  readOnly
                  value={undeliveredInvite.acceptUrl}
                />
                <button className="secondary-button" onClick={copyAcceptUrl} type="button">
                  <Copy size={14} />
                  Copy link
                </button>
              </div>
            </div>
          )}
          <label className="span-two">
            Email
            <input
              aria-label="Email address"
              name="email"
              placeholder="teammate@company.com"
              required
              type="email"
            />
          </label>
          <label className="span-two">
            Role
            <select aria-label="Role" defaultValue="developer" name="role">
              {roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions span-two">
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? <Loader2 className="spin" size={15} /> : <Mail size={15} />}
              Send Invite
            </button>
          </div>
        </form>
      </Drawer>

      <ConfirmModal
        busy={confirmBusy}
        confirmLabel="Remove member"
        message={
          <>
            Remove <strong>{removingMember?.name}</strong> from the organization? They will lose access
            immediately.
          </>
        }
        onClose={() => setRemovingMember(null)}
        onConfirm={confirmRemoveMember}
        open={removingMember !== null}
        title="Remove member"
      />

      <ConfirmModal
        busy={confirmBusy}
        confirmLabel="Revoke invitation"
        message={
          <>
            Revoke the invitation for <strong>{revokingInvite?.email}</strong>? The invite link will stop
            working.
          </>
        }
        onClose={() => setRevokingInvite(null)}
        onConfirm={confirmRevoke}
        open={revokingInvite !== null}
        title="Revoke invitation"
      />
    </div>
  );
}

/* ---------- Audit ---------- */

/** Sign-in events, kept separate from the rest of the activity feed. */
const LOGIN_ACTIONS = new Set(["auth.login", "auth.google.login", "auth.login.failed"]);
const isLoginLog = (log: AuditLog) => LOGIN_ACTIONS.has(log.action);

type AuditFilter = "all" | "logins" | "activity";

const AUDIT_FILTERS: Array<{ value: AuditFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "logins", label: "Logins" },
  { value: "activity", label: "Activity" },
];

export function AuditView({
  logs,
  loading,
  memberNames,
}: {
  logs: AuditLog[];
  loading: boolean;
  memberNames: Map<string, string>;
}) {
  const [filter, setFilter] = useState<AuditFilter>("all");

  const actorName = useCallback(
    (log: AuditLog) => memberNames.get(log.actorId) ?? "system",
    [memberNames],
  );

  const visibleLogs = useMemo(() => {
    if (filter === "logins") return logs.filter(isLoginLog);
    if (filter === "activity") return logs.filter((log) => !isLoginLog(log));
    return logs;
  }, [logs, filter]);

  const columns = useMemo<DataColumn<AuditLog>[]>(
    () => [
      {
        key: "date",
        header: "Date",
        width: "minmax(110px, 0.7fr)",
        sortValue: (log) => new Date(log.createdAt).getTime(),
        render: (log) => <span className="data-muted">{shortDate(log.createdAt)}</span>,
      },
      {
        key: "time",
        header: "Time",
        width: "minmax(90px, 0.5fr)",
        sortValue: (log) => new Date(log.createdAt).getTime(),
        render: (log) => (
          <span className="data-muted">
            {new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        ),
      },
      {
        key: "action",
        header: "Action",
        width: "minmax(180px, 1.4fr)",
        sortValue: (log) => log.action,
        render: (log) => <strong>{log.action.replaceAll(".", " · ")}</strong>,
      },
      {
        key: "actor",
        header: "Actor",
        width: "minmax(140px, 1fr)",
        sortValue: actorName,
        render: (log) => <span>{actorName(log)}</span>,
      },
      {
        key: "target",
        header: "Target",
        width: "minmax(140px, 1fr)",
        sortValue: (log) => log.targetType,
        render: (log) => (
          <span className="data-muted">
            {log.targetType}
            {log.targetId ? ` · ${log.targetId.slice(0, 8)}` : ""}
          </span>
        ),
      },
      {
        key: "ip",
        header: "IP",
        width: "minmax(110px, 0.6fr)",
        sortValue: (log) => log.ipAddress ?? "",
        render: (log) => <span className="data-mono">{log.ipAddress ?? "—"}</span>,
      },
    ],
    [actorName],
  );

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Audit Log</h2>
          <p>Every session, credential, and admin action in this organization.</p>
        </div>
      </div>
      <DataTable
        columns={columns}
        defaultSort={{ key: "date", dir: "desc" }}
        empty={{
          icon: <ScrollText size={22} />,
          title: filter === "logins" ? "No login events yet" : "No audit events yet",
          hint: "Activity will appear here as your team works.",
        }}
        leftTools={
          <div className="segmented" style={{ gridTemplateColumns: "repeat(3, minmax(64px, auto))" }}>
            {AUDIT_FILTERS.map((option) => (
              <button
                className={cx(filter === option.value && "selected")}
                key={option.value}
                onClick={() => setFilter(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        }
        loading={loading}
        rowKey={(log) => log.id}
        rows={visibleLogs}
        searchPlaceholder="Search actions, actors, targets…"
        searchText={(log) =>
          `${log.action} ${actorName(log)} ${log.targetType} ${log.targetId ?? ""} ${log.ipAddress ?? ""} ${shortDate(log.createdAt)}`
        }
      />
    </section>
  );
}

/* ---------- Settings ---------- */

const modeSwatches: Record<ThemeMode, string[]> = {
  dark: ["#0a0b12", "#1c1d2b", "#818cf8"],
  light: ["#f6f5ff", "#efeafe", "#4f46e5"],
};

const AVATAR_SIZE = 256;

/** Read an image file and return a centered-square 256px JPEG data URL. */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that image file."));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file is not a valid image."));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new Error("Image processing is not available in this browser.");
  const side = Math.min(image.width, image.height);
  const sx = (image.width - side) / 2;
  const sy = (image.height - side) / 2;
  ctx.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function passwordReqs(
  password: string,
): Array<{ label: string; met: boolean }> {
  const reqs = [
    {
      label: `At least ${passwordPolicy.minLength} characters`,
      met: password.length >= passwordPolicy.minLength,
    },
  ];
  if (passwordPolicy.requireLowercase)
    reqs.push({ label: "One lowercase letter", met: /[a-z]/.test(password) });
  if (passwordPolicy.requireUppercase)
    reqs.push({ label: "One uppercase letter", met: /[A-Z]/.test(password) });
  if (passwordPolicy.requireDigit)
    reqs.push({ label: "One number", met: /[0-9]/.test(password) });
  if (passwordPolicy.requireSymbol)
    reqs.push({
      label: "One symbol (!@#?…)",
      met: /[^a-zA-Z0-9]/.test(password),
    });
  return reqs;
}

function passwordChangeError(err: unknown): string {
  const code = err instanceof Error ? err.message : "";
  switch (code) {
    case "invalid_current_password":
      return "Your current password is incorrect.";
    case "password_policy_violation":
      return "The new password does not meet the requirements.";
    case "password_reuse":
      return "Choose a password different from your current one.";
    case "password_not_set":
      return "This account signs in with Google, so it has no password to change.";
    case "unauthorized":
      return "Your session expired. Please sign in again.";
    default:
      return code || "Could not update your password.";
  }
}

const settingsTabs = [
  { key: "profile", label: "Profile", icon: UserRound },
  { key: "organization", label: "Organization", icon: Building2 },
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "security", label: "Two-Factor", icon: ShieldCheck },
  { key: "password", label: "Password", icon: KeyRound },
  { key: "session", label: "Session", icon: LogOut },
] as const;

type SettingsTab = (typeof settingsTabs)[number]["key"];

export function SettingsView({
  user,
  organizationName,
  organization,
  onOrgUpdated,
  mode,
  onMode,
  accent,
  onAccent,
  onLogout,
  onProfileUpdated,
  notify,
}: {
  user: User;
  organizationName: string;
  organization?: Organization | null;
  onOrgUpdated?: (organization: Organization) => void;
  mode: ThemeMode;
  onMode: (mode: ThemeMode) => void;
  accent: AccentValue;
  onAccent: (value: AccentValue) => void;
  onLogout: () => void;
  onProfileUpdated: (user: User) => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [twoFa, setTwoFa] = useState<{
    enabled: boolean;
    method?: "totp" | "email" | null;
  } | null>(null);
  const [qr, setQr] = useState<{
    qrCodeDataUrl?: string;
    manualEntryKey?: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailPending, setEmailPending] = useState(false);

  const [tab, setTab] = useState<SettingsTab>("profile");

  const accentIsPreset = ACCENT_PRESETS.some((preset) => preset.key === accent);
  const accentIsCustom = !accentIsPreset && !isDefaultAccent(accent);
  const customHex = accentToHex(accent);

  const currentOrgName = organization?.name ?? organizationName ?? "";
  const [orgName, setOrgName] = useState(currentOrgName);
  const [savingOrg, setSavingOrg] = useState(false);
  useEffect(() => {
    setOrgName(currentOrgName);
  }, [currentOrgName]);
  const canEditOrg = canManageUsers(user.role);
  const orgDirty = orgName.trim().length >= 2 && orgName.trim() !== currentOrgName.trim();

  async function saveOrganization() {
    if (!orgDirty) return;
    setSavingOrg(true);
    try {
      const { organization: updated } = await consoleApi.updateOrganization({ name: orgName.trim() });
      onOrgUpdated?.(updated);
      notify("Organization updated.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update organization.", "error");
    } finally {
      setSavingOrg(false);
    }
  }

  /* profile */
  const [name, setName] = useState(user.name);
  const [avatar, setAvatar] = useState<string | null>(user.avatarUrl ?? null);
  const [savingProfile, setSavingProfile] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  /* password */
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const profileDirty =
    name.trim() !== user.name || (avatar ?? null) !== (user.avatarUrl ?? null);
  const newPasswordValid = validatePassword(newPassword).valid;
  const passwordsMatch = newPassword === confirmPassword;

  async function onAvatarPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      notify("Please choose an image file.", "error");
      return;
    }
    try {
      setAvatar(await fileToAvatarDataUrl(file));
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not process that image.",
        "error",
      );
    }
  }

  async function saveProfile() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      notify("Name needs at least 2 characters.", "error");
      return;
    }
    setSavingProfile(true);
    try {
      const body: { name?: string; avatarUrl?: string | null } = {};
      if (trimmed !== user.name) body.name = trimmed;
      if ((avatar ?? null) !== (user.avatarUrl ?? null))
        body.avatarUrl = avatar ?? "";
      const { user: updated } = await consoleApi.updateProfile(body);
      onProfileUpdated(updated);
      notify("Profile updated.", "success");
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not update your profile.",
        "error",
      );
    } finally {
      setSavingProfile(false);
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newPasswordValid) {
      notify("The new password does not meet the requirements.", "error");
      return;
    }
    if (!passwordsMatch) {
      notify("New password and confirmation do not match.", "error");
      return;
    }
    setSavingPassword(true);
    try {
      await consoleApi.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      notify(
        "Password updated. Your other sessions were signed out.",
        "success",
      );
    } catch (err) {
      notify(passwordChangeError(err), "error");
    } finally {
      setSavingPassword(false);
    }
  }

  const loadStatus = useCallback(async () => {
    try {
      setTwoFa(await consoleApi.twoFactorStatus());
    } catch {
      setTwoFa({ enabled: user.twoFactorEnabled });
    }
  }, [user.twoFactorEnabled]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function startTotp() {
    setBusy(true);
    try {
      setQr(await consoleApi.setupTotp());
      setEmailPending(false);
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not start 2FA setup.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await consoleApi.verifyTotp(code);
      notify("Google Authenticator 2FA enabled.", "success");
      setQr(null);
      setCode("");
      await loadStatus();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Code was not accepted.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startEmailOtp() {
    setBusy(true);
    try {
      await consoleApi.enableEmailOtp();
      setEmailPending(true);
      setQr(null);
      notify("We emailed you a confirmation code.", "success");
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not send the code.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmEmailOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await consoleApi.verifyEmailOtp(code);
      notify("Email OTP 2FA enabled.", "success");
      setEmailPending(false);
      setCode("");
      await loadStatus();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Code was not accepted.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-shell">
      <div className="settings-header">
        <h1>Settings</h1>
        <p>Manage your profile, organization, and workspace preferences.</p>
      </div>
      <nav className="settings-tabs" aria-label="Settings sections">
        {settingsTabs.map((item) => (
          <button
            aria-current={tab === item.key ? "page" : undefined}
            className={cx("settings-tab", tab === item.key && "is-active")}
            key={item.key}
            onClick={() => setTab(item.key)}
            type="button"
          >
            <item.icon size={16} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="settings-content">
        {tab === "profile" && (
          <section className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Profile</h2>
                <p>Your name and photo across the workspace.</p>
              </div>
            </div>
            <div className="settings-block">
              <div className="profile-row">
                <div className="profile-avatar">
                  {avatar ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img alt="Your profile photo" src={avatar} />
                  ) : (
                    <span className="profile-avatar-fallback">
                      {initials(name || user.name)}
                    </span>
                  )}
                </div>
                <div className="profile-avatar-actions">
                  <input
                    accept="image/*"
                    hidden
                    onChange={onAvatarPick}
                    ref={avatarInputRef}
                    type="file"
                  />
                  <div className="inline-form">
                    <button
                      className="secondary-button"
                      onClick={() => avatarInputRef.current?.click()}
                      type="button"
                    >
                      <Camera size={15} />
                      {avatar ? "Change photo" : "Upload photo"}
                    </button>
                    {avatar && (
                      <button
                        className="ghost-button"
                        onClick={() => setAvatar(null)}
                        type="button"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="profile-hint">
                    JPG, PNG, or GIF — resized to a 256px square.
                  </p>
                </div>
              </div>
              <label className="field">
                <span>Name</span>
                <input
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your name"
                  value={name}
                />
              </label>
              <label className="field">
                <span>Email</span>
                <input disabled readOnly value={user.email} />
              </label>
              <button
                className="primary-button"
                disabled={savingProfile || !profileDirty}
                onClick={saveProfile}
                type="button"
              >
                {savingProfile ? (
                  <Loader2 className="spin" size={15} />
                ) : (
                  <Save size={15} />
                )}
                {savingProfile ? "Saving…" : "Save profile"}
              </button>
            </div>
          </section>
        )}

        {tab === "organization" && (
          <section className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Organization</h2>
                <p>Your workspace name and details.</p>
              </div>
            </div>
            <div className="settings-block">
              <div className="org-summary">
                <span className="org-summary-mark">
                  <Building2 size={20} />
                </span>
                <div className="org-summary-meta">
                  <strong>{currentOrgName || "Workspace"}</strong>
                  <span>{organization?.slug ? `Workspace · ${organization.slug}` : "Your team workspace"}</span>
                </div>
                <span className="org-summary-role">{user.role}</span>
              </div>
              <label className="field">
                <span>Organization name</span>
                <input
                  disabled={!canEditOrg || savingOrg}
                  maxLength={120}
                  onChange={(event) => setOrgName(event.target.value)}
                  placeholder="Organization name"
                  value={orgName}
                />
              </label>
              {organization?.slug && (
                <label className="field">
                  <span>Workspace slug</span>
                  <input disabled readOnly value={organization.slug} />
                </label>
              )}
              {canEditOrg ? (
                <button
                  className="primary-button"
                  disabled={savingOrg || !orgDirty}
                  onClick={saveOrganization}
                  type="button"
                >
                  {savingOrg ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                  {savingOrg ? "Saving…" : "Save organization"}
                </button>
              ) : (
                <p className="profile-hint">Only owners and admins can change organization details.</p>
              )}
            </div>
          </section>
        )}

        {tab === "appearance" && (
          <section className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Appearance</h2>
                <p>Theme and accent colour, synced to your account.</p>
              </div>
            </div>
            <div className="appearance-body">
              <div className="appearance-group">
                <span className="appearance-label">Mode</span>
                <div className="theme-options">
                  {(Object.keys(modeSwatches) as ThemeMode[]).map((name) => (
                    <button
                      className={cx("theme-option", mode === name && "is-active")}
                      key={name}
                      onClick={() => onMode(name)}
                      type="button"
                    >
                      <span className="theme-swatch" style={{ background: modeSwatches[name][0] }}>
                        {modeSwatches[name].map((color) => (
                          <i key={color} style={{ background: color }} />
                        ))}
                      </span>
                      {name === "dark" ? "Dark" : "Light"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="appearance-group">
                <span className="appearance-label">Accent colour</span>
                <div className="accent-grid">
                  {ACCENT_PRESETS.map((preset) => (
                    <button
                      aria-label={preset.label}
                      aria-pressed={accent === preset.key}
                      className={cx("accent-swatch", accent === preset.key && "is-active")}
                      key={preset.key}
                      onClick={() => onAccent(preset.key)}
                      style={{ "--sw": preset.hex } as CSSProperties}
                      title={preset.label}
                      type="button"
                    >
                      {accent === preset.key && <Check size={15} />}
                    </button>
                  ))}
                  <label
                    className={cx("accent-swatch accent-custom", accentIsCustom && "is-active")}
                    style={{ "--sw": customHex } as CSSProperties}
                    title="Custom colour"
                  >
                    <Palette size={14} />
                    <input
                      aria-label="Custom accent colour"
                      onChange={(event) => onAccent(event.target.value)}
                      type="color"
                      value={customHex}
                    />
                  </label>
                </div>
                <p className="appearance-hint">
                  Pick a preset or choose a custom colour — the whole workspace recolours instantly.
                </p>
              </div>
            </div>
          </section>
        )}

        {tab === "security" && (
          <section className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Two-factor authentication</h2>
                <p>Add a second verification step at every login.</p>
              </div>
            </div>
            <div className="settings-block">
              <p>
                {twoFa?.enabled
                  ? `Enabled via ${twoFa.method === "email" ? "email OTP" : "Google Authenticator"}.`
                  : "Protect your account with Google Authenticator or an email OTP at every login."}
              </p>
              {!twoFa?.enabled && !qr && !emailPending && (
                <div className="inline-form">
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={startTotp}
                    type="button"
                  >
                    <ShieldCheck size={15} />
                    Google Authenticator
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={startEmailOtp}
                    type="button"
                  >
                    <Mail size={15} />
                    Email OTP
                  </button>
                </div>
              )}
              {qr && (
                <form onSubmit={confirmTotp}>
                  {qr.qrCodeDataUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      alt="Scan this QR code with Google Authenticator"
                      className="twofa-qr"
                      src={qr.qrCodeDataUrl}
                    />
                  )}
                  {qr.manualEntryKey && (
                    <p
                      style={{
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: 12,
                      }}
                    >
                      Manual key: {qr.manualEntryKey}
                    </p>
                  )}
                  <div className="inline-form">
                    <input
                      aria-label="6-digit code"
                      inputMode="numeric"
                      maxLength={6}
                      onChange={(event) => setCode(event.target.value)}
                      placeholder="123456"
                      required
                      value={code}
                    />
                    <button
                      className="primary-button"
                      disabled={busy || code.length !== 6}
                      type="submit"
                    >
                      Verify
                    </button>
                  </div>
                </form>
              )}
              {emailPending && (
                <form className="inline-form" onSubmit={confirmEmailOtp}>
                  <input
                    aria-label="Code from email"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Code from email"
                    required
                    value={code}
                  />
                  <button
                    className="primary-button"
                    disabled={busy || code.length !== 6}
                    type="submit"
                  >
                    Verify
                  </button>
                </form>
              )}
            </div>
          </section>
        )}

        {tab === "password" && (
          <section className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Password</h2>
                <p>
                  Change your password. Saving signs out your other devices.
                </p>
              </div>
            </div>
            <div className="settings-block">
              <form className="password-form" onSubmit={submitPassword}>
                <label className="field">
                  <span>Current password</span>
                  <input
                    autoComplete="current-password"
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    required
                    type="password"
                    value={currentPassword}
                  />
                </label>
                <label className="field">
                  <span>New password</span>
                  <span className="pw-field">
                    <input
                      autoComplete="new-password"
                      onChange={(event) => setNewPassword(event.target.value)}
                      required
                      type={showNewPassword ? "text" : "password"}
                      value={newPassword}
                    />
                    <button
                      aria-label={
                        showNewPassword ? "Hide password" : "Show password"
                      }
                      className="pw-reveal"
                      onClick={() => setShowNewPassword((visible) => !visible)}
                      type="button"
                    >
                      {showNewPassword ? (
                        <EyeOff size={15} />
                      ) : (
                        <Eye size={15} />
                      )}
                    </button>
                  </span>
                </label>
                <label className="field">
                  <span>Confirm new password</span>
                  <input
                    autoComplete="new-password"
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    type={showNewPassword ? "text" : "password"}
                    value={confirmPassword}
                  />
                </label>
                {newPassword.length > 0 && (
                  <ul className="pw-reqs">
                    {passwordReqs(newPassword).map((requirement) => (
                      <li
                        className={cx(
                          "pw-req",
                          requirement.met ? "met" : "unmet",
                        )}
                        key={requirement.label}
                      >
                        {requirement.met ? (
                          <Check size={13} />
                        ) : (
                          <Circle size={13} />
                        )}
                        <span>{requirement.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {confirmPassword.length > 0 && !passwordsMatch && (
                  <p className="pw-mismatch">Passwords do not match.</p>
                )}
                <button
                  className="primary-button"
                  disabled={
                    savingPassword ||
                    !currentPassword ||
                    !newPasswordValid ||
                    !passwordsMatch
                  }
                  type="submit"
                >
                  {savingPassword ? (
                    <Loader2 className="spin" size={15} />
                  ) : (
                    <KeyRound size={15} />
                  )}
                  {savingPassword ? "Updating…" : "Update password"}
                </button>
              </form>
            </div>
          </section>
        )}

        {tab === "session" && (
          <section className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Session</h2>
                <p>Sign out of Onshell on this device.</p>
              </div>
            </div>
            <div className="settings-block">
              <p className="settings-account-line">
                Signed in as <strong>{user.name}</strong> · {user.email} ·{" "}
                {organizationName}
              </p>
              <button
                className="danger-button"
                onClick={onLogout}
                type="button"
              >
                <LogOut size={15} />
                Log out
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
