"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  File as FileIcon,
  FileWarning,
  Folder,
  FolderLock,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Unplug,
  X
} from "lucide-react";
import type { Host } from "@onshell/shared";
import { isShellHost } from "@onshell/shared";
import { cx } from "@onshell/ui";
import { ApiError, consoleApi, MAX_EDITABLE_FILE_BYTES } from "./api";
import type { RemoteDirectory, RemoteFileContent, RemoteFileEntry } from "./api";
import "./files.css";

type Notify = (message: string, kind?: "success" | "error") => void;

type PaneSide = "left" | "right";

/** Entries lifted out of a pane by Copy, waiting for a Paste on the other side. */
interface Clipboard {
  entries: RemoteFileEntry[];
  hostName: string;
  /** Directory the entries were copied from, so paths survive later navigation. */
  path: string;
  sessionId: string;
}

/** The single modal the view can have open at a time. */
type DialogRequest =
  | { kind: "delete"; side: PaneSide }
  | { kind: "mkdir"; side: PaneSide }
  | { kind: "rename"; side: PaneSide };

interface EditorTarget {
  path: string;
  sessionId: string;
  side: PaneSide;
  /** From the listing, so an oversized file can be refused without a round trip. */
  size: number;
}

/* ------------------------------------------------------------------ paths */

/** Joins a resolved directory with an entry name, tolerating a trailing slash. */
function joinPath(directory: string, name: string): string {
  const base = directory.replace(/\/+$/, "");
  return base === "" ? `/${name}` : `${base}/${name}`;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return trimmed;
  return cut === 0 ? "/" : trimmed.slice(0, cut);
}

/** Ancestors of an absolute path, root first, for the clickable breadcrumb. */
function breadcrumbs(path: string): Array<{ label: string; path: string }> {
  // A path the server has not resolved yet (".") has no ancestors to offer.
  if (!path.startsWith("/")) return [{ label: path, path }];
  const crumbs = [{ label: "/", path: "/" }];
  let walked = "";
  for (const segment of path.split("/").filter(Boolean)) {
    walked += `/${segment}`;
    crumbs.push({ label: segment, path: walked });
  }
  return crumbs;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatModified(seconds: number): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    undefined,
    thisYear ? { day: "2-digit", month: "short" } : { month: "short", year: "numeric" }
  );
}

/* ------------------------------------------------------------------ errors */

/** Turns a failed listing into something the user can act on. */
function listingError(error: unknown, path: string): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 404:
        return `"${path}" does not exist on this host.`;
      case 403:
        return `You do not have permission to read "${path}".`;
      case 409:
        return "This file session has closed. Pick the host again to reconnect.";
      default:
        return error.message || `Could not read "${path}".`;
    }
  }
  return `Could not read "${path}".`;
}

/** Same idea for the write operations, which report on a per-item basis. */
function actionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Permission denied on the remote host.";
    if (error.status === 404) return "That path no longer exists.";
    if (error.status === 409) return "The file session has closed. Reconnect the pane.";
    return error.message || "The operation failed.";
  }
  return "The operation failed.";
}

/* --------------------------------------------------------------- listings */

/**
 * The listing endpoint is typed loosely because gateways have shipped a few
 * shapes of it, so entries are narrowed here rather than cast — a stray field
 * must never reach the table as `undefined`.
 */
function normalizeEntry(raw: unknown): RemoteFileEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : typeof item.filename === "string" ? item.filename : "";
  if (!name || name === "." || name === "..") return null;
  const directory =
    item.type === "directory" || item.type === "d" || item.directory === true || item.isDirectory === true;
  return {
    modifiedAt: typeof item.modifiedAt === "number" ? item.modifiedAt : 0,
    name,
    size: typeof item.size === "number" ? item.size : 0,
    type: directory ? "directory" : item.type === "other" ? "other" : "file"
  };
}

function normalizeListing(payload: { path?: string; entries?: unknown[] }, requested: string): RemoteDirectory {
  const entries = (payload.entries ?? [])
    .map(normalizeEntry)
    .filter((entry): entry is RemoteFileEntry => entry !== null)
    .sort(
      (a, b) =>
        Number(b.type === "directory") - Number(a.type === "directory") ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    );
  // Prefer the path the server resolved: "." lands in the account's home
  // directory and the breadcrumb has to say where that actually is.
  return { entries, path: typeof payload.path === "string" && payload.path ? payload.path : requested };
}

/* ------------------------------------------------------------------- pane */

interface Pane {
  attach: (host: Host) => void;
  /** A listing is in flight; the previous one stays on screen meanwhile. */
  busy: boolean;
  dir: RemoteDirectory | null;
  error: string | null;
  host: Host | null;
  jump: (path: string) => void;
  pathDraft: string;
  refresh: () => void;
  release: () => void;
  resetDraft: () => void;
  selectAll: (on: boolean) => void;
  selected: string[];
  sessionId: string | null;
  setPathDraft: (value: string) => void;
  /** Opening the session, before the first listing arrives. */
  starting: boolean;
  toggle: (name: string, extend: boolean) => void;
}

/**
 * One pane's session, listing, and selection. Called once per side so the two
 * panes never share state — either can point at a different host, or at none.
 */
function usePane(launch: (host: Host) => Promise<string>): Pane {
  const [busy, setBusy] = useState(false);
  const [dir, setDir] = useState<RemoteDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<Host | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  /** Shift-click range origin. */
  const anchor = useRef<string | null>(null);
  const dirRef = useRef<RemoteDirectory | null>(null);
  const sessionRef = useRef<string | null>(null);
  /** A slow listing must not overwrite a newer one the user has moved on to. */
  const requestId = useRef(0);

  useEffect(() => {
    dirRef.current = dir;
  }, [dir]);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // An SFTP channel held open for a pane nobody can see is a wasted connection
  // on the remote host, so leaving the view releases both sides.
  useEffect(
    () => () => {
      const open = sessionRef.current;
      if (open) void consoleApi.closeSession(open).catch(() => undefined);
    },
    []
  );

  const list = useCallback(async (session: string, path: string) => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const payload = await consoleApi.listFiles(session, path);
      if (id !== requestId.current) return;
      const listing = normalizeListing(payload, path);
      setDir(listing);
      setPathDraft(listing.path);
      setSelected([]);
      anchor.current = null;
    } catch (failure) {
      if (id !== requestId.current) return;
      // Deliberately leaves `dir` alone: a typo in the path bar should not wipe
      // the listing the user was reading.
      setError(listingError(failure, path));
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  const attach = useCallback(
    async (next: Host) => {
      const previous = sessionRef.current;
      setStarting(true);
      setError(null);
      try {
        const opened = await launch(next);
        if (previous && previous !== opened) void consoleApi.closeSession(previous).catch(() => undefined);
        sessionRef.current = opened;
        setSessionId(opened);
        setHost(next);
        setDir(null);
        setSelected([]);
        setPathDraft(".");
        await list(opened, ".");
      } catch (failure) {
        setError(failure instanceof Error && failure.message ? failure.message : "Could not open a file session.");
      } finally {
        setStarting(false);
      }
    },
    [launch, list]
  );

  const release = useCallback(() => {
    const open = sessionRef.current;
    if (open) void consoleApi.closeSession(open).catch(() => undefined);
    requestId.current += 1;
    sessionRef.current = null;
    anchor.current = null;
    setBusy(false);
    setDir(null);
    setError(null);
    setHost(null);
    setPathDraft("");
    setSelected([]);
    setSessionId(null);
  }, []);

  const jump = useCallback(
    (path: string) => {
      const open = sessionRef.current;
      if (!open) return;
      void list(open, path.trim() || ".");
    },
    [list]
  );

  const refresh = useCallback(() => {
    const open = sessionRef.current;
    if (!open) return;
    void list(open, dirRef.current?.path ?? ".");
  }, [list]);

  const resetDraft = useCallback(() => {
    setPathDraft(dirRef.current?.path ?? "");
  }, []);

  const selectAll = useCallback((on: boolean) => {
    anchor.current = null;
    setSelected(on ? (dirRef.current?.entries ?? []).map((entry) => entry.name) : []);
  }, []);

  const toggle = useCallback((name: string, extend: boolean) => {
    const names = (dirRef.current?.entries ?? []).map((entry) => entry.name);
    setSelected((current) => {
      if (extend && anchor.current) {
        const from = names.indexOf(anchor.current);
        const to = names.indexOf(name);
        if (from >= 0 && to >= 0) {
          const range = names.slice(Math.min(from, to), Math.max(from, to) + 1);
          return Array.from(new Set([...current, ...range]));
        }
      }
      anchor.current = name;
      return current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
    });
  }, []);

  return useMemo(
    () => ({
      attach: (next: Host) => void attach(next),
      busy,
      dir,
      error,
      host,
      jump,
      pathDraft,
      refresh,
      release,
      resetDraft,
      selectAll,
      selected,
      sessionId,
      setPathDraft,
      starting,
      toggle
    }),
    [
      attach,
      busy,
      dir,
      error,
      host,
      jump,
      pathDraft,
      refresh,
      release,
      resetDraft,
      selectAll,
      selected,
      sessionId,
      starting,
      toggle
    ]
  );
}

/* ---------------------------------------------------------------- dialogs */

function Dialog({
  children,
  onClose,
  subtitle,
  title
}: {
  children: ReactNode;
  onClose: () => void;
  subtitle?: string;
  title: string;
}) {
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    card.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
  }, []);

  return (
    <div
      className="fm-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div
        aria-labelledby="fm-dialog-title"
        aria-modal="true"
        className="fm-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={card}
        role="dialog"
      >
        <div className="fm-dialog-head">
          <div>
            <h3 id="fm-dialog-title">{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button aria-label="Close dialog" className="icon-button compact" onClick={onClose} type="button">
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Shared by "New folder" and "Rename": one name, validated the same way. */
function NamePrompt({
  confirmLabel,
  initial,
  label,
  onClose,
  onSubmit,
  subtitle,
  title
}: {
  confirmLabel: string;
  initial: string;
  label: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
  subtitle?: string;
  title: string;
}) {
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = value.trim();
    if (!name) {
      setProblem("Enter a name.");
      return;
    }
    if (name.includes("/")) {
      setProblem("Use a name without slashes — this stays in the current directory.");
      return;
    }
    onSubmit(name);
  };

  return (
    <Dialog onClose={onClose} subtitle={subtitle} title={title}>
      <form className="fm-dialog-body" onSubmit={submit}>
        <label className="fm-field">
          {label}
          <input
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setProblem(null);
            }}
            spellCheck={false}
            value={value}
          />
        </label>
        {problem && <p className="fm-dialog-problem">{problem}</p>}
        <div className="fm-dialog-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-button" type="submit">
            {confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeletePrompt({
  entries,
  onClose,
  onConfirm
}: {
  entries: RemoteFileEntry[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  const directories = entries.filter((entry) => entry.type === "directory");
  return (
    <Dialog
      onClose={onClose}
      subtitle={`${entries.length} item${entries.length === 1 ? "" : "s"} on the remote host. This cannot be undone.`}
      title="Delete selected"
    >
      <div className="fm-dialog-body">
        <ul className="fm-dialog-list">
          {entries.map((entry) => (
            <li key={entry.name}>
              {entry.type === "directory" ? <Folder size={14} /> : <FileIcon size={14} />}
              <span>{entry.name}</span>
            </li>
          ))}
        </ul>
        {directories.length > 0 && (
          <p className="fm-dialog-warning">
            <AlertTriangle size={15} />
            {directories.length === 1
              ? `"${directories[0].name}" is a directory — it and everything inside it will be removed.`
              : `${directories.length} directories will be removed recursively, with everything inside them.`}
          </p>
        )}
        <div className="fm-dialog-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="danger-button solid" onClick={onConfirm} type="button">
            <Trash2 size={15} />
            Delete
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- editor */

function FileEditor({
  notify,
  onClose,
  onSaved,
  target
}: {
  notify: Notify;
  onClose: () => void;
  onSaved: () => void;
  target: EditorTarget;
}) {
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<RemoteFileContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);

  const name = target.path.split("/").pop() ?? target.path;
  const dirty = file?.content !== undefined && draft !== saved;

  useEffect(() => {
    // Refuse oversized files from the listing metadata alone: reading a 400 MB
    // log just to be told it is too large costs the gateway real work.
    if (target.size > MAX_EDITABLE_FILE_BYTES) {
      setFile({ binary: false, path: target.path, size: target.size, tooLarge: true });
      setLoading(false);
      return;
    }
    let active = true;
    consoleApi
      .readFile(target.sessionId, target.path)
      .then((content) => {
        if (!active) return;
        setFile(content);
        setDraft(content.content ?? "");
        setSaved(content.content ?? "");
      })
      .catch((failure: unknown) => {
        if (active) setLoadError(actionError(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [target.path, target.sessionId, target.size]);

  const close = useCallback(() => {
    if (dirty && !window.confirm(`Discard unsaved changes to ${name}?`)) return;
    onClose();
  }, [dirty, name, onClose]);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await consoleApi.writeFile(target.sessionId, target.path, draft);
      setSaved(draft);
      notify(`Saved ${name}`);
      onSaved();
    } catch (failure) {
      notify(actionError(failure), "error");
    } finally {
      setSaving(false);
    }
  }, [draft, name, notify, onSaved, saving, target.path, target.sessionId]);

  // Ctrl/Cmd+S is the reflex for anyone editing text; Escape leaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (file?.content !== undefined) void save();
      }
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, file, save]);

  const blocked = file?.binary || file?.tooLarge;

  return (
    <div className="fm-overlay" onClick={close} role="presentation">
      <div
        aria-labelledby="fm-editor-title"
        aria-modal="true"
        className="fm-editor"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="fm-editor-head">
          <div className="fm-editor-title">
            <FileIcon size={15} />
            <strong id="fm-editor-title">{name}</strong>
            <code>{target.path}</code>
            {dirty && <span className="fm-editor-dirty">Unsaved</span>}
          </div>
          <div className="fm-editor-actions">
            {file?.content !== undefined && (
              <button
                className="primary-button"
                disabled={saving || !dirty}
                onClick={() => void save()}
                type="button"
              >
                {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                {saving ? "Saving…" : "Save"}
              </button>
            )}
            <button aria-label="Close editor" className="icon-button" onClick={close} type="button">
              <X size={16} />
            </button>
          </div>
        </div>

        {loading && (
          <div className="fm-editor-state">
            <Loader2 className="spin" size={20} />
            <span>Reading file…</span>
          </div>
        )}

        {!loading && loadError && (
          <div className="fm-editor-state">
            <AlertTriangle size={20} />
            <strong>Could not open this file</strong>
            <span>{loadError}</span>
          </div>
        )}

        {!loading && !loadError && blocked && (
          <div className="fm-editor-state">
            <FileWarning size={20} />
            <strong>This file cannot be edited here</strong>
            <span>
              {file?.tooLarge
                ? `It is ${formatBytes(file.size)}; the editor opens files up to ${formatBytes(MAX_EDITABLE_FILE_BYTES)}.`
                : "It is not UTF-8 text, so editing it in a textarea would corrupt it."}
            </span>
          </div>
        )}

        {!loading && !loadError && !blocked && file?.content !== undefined && (
          <textarea
            aria-label={`Contents of ${name}`}
            className="fm-editor-area"
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            value={draft}
          />
        )}

        <div className="fm-editor-foot">
          <span>{file ? formatBytes(file.size) : ""}</span>
          <span>{file?.content !== undefined ? "Ctrl/Cmd + S saves · Esc closes" : "Esc closes"}</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- view */

export function FilesView({
  hosts,
  notify,
  onLaunchFileSession
}: {
  hosts: Host[];
  notify: Notify;
  /** Opens a new sftp session for a host; resolves to the Onshell session id. */
  onLaunchFileSession: (host: Host) => Promise<string>;
}) {
  const left = usePane(onLaunchFileSession);
  const right = usePane(onLaunchFileSession);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [paste, setPaste] = useState<{ done: number; side: PaneSide; total: number } | null>(null);

  const shellHosts = useMemo(() => hosts.filter(isShellHost), [hosts]);
  const paneFor = useCallback((side: PaneSide) => (side === "left" ? left : right), [left, right]);

  const selectionOf = useCallback(
    (pane: Pane) => (pane.dir?.entries ?? []).filter((entry) => pane.selected.includes(entry.name)),
    []
  );

  const copyFrom = useCallback(
    (side: PaneSide) => {
      const pane = paneFor(side);
      const entries = selectionOf(pane);
      if (!pane.sessionId || !pane.dir || entries.length === 0) return;
      setClipboard({
        entries,
        hostName: pane.host?.name ?? "host",
        path: pane.dir.path,
        sessionId: pane.sessionId
      });
      notify(`${entries.length} item${entries.length === 1 ? "" : "s"} ready to paste`);
    },
    [notify, paneFor, selectionOf]
  );

  const pasteInto = useCallback(
    async (side: PaneSide) => {
      const pane = paneFor(side);
      const source = clipboard;
      if (!source || !pane.sessionId || !pane.dir || paste) return;
      const total = source.entries.length;
      let copied = 0;
      const failures: string[] = [];
      setPaste({ done: 0, side, total });
      for (const entry of source.entries) {
        try {
          await consoleApi.copyBetweenSessions({
            fromPath: joinPath(source.path, entry.name),
            fromSessionId: source.sessionId,
            toPath: joinPath(pane.dir.path, entry.name),
            toSessionId: pane.sessionId
          });
          copied += 1;
        } catch (failure) {
          failures.push(`${entry.name}: ${actionError(failure)}`);
        }
        setPaste({ done: copied + failures.length, side, total });
      }
      setPaste(null);
      pane.refresh();
      if (failures.length === 0) notify(`Copied ${copied} item${copied === 1 ? "" : "s"}`);
      else notify(`Copied ${copied} of ${total} — ${failures[0]}`, "error");
    },
    [clipboard, notify, paneFor, paste]
  );

  const makeDirectory = useCallback(
    async (side: PaneSide, name: string) => {
      const pane = paneFor(side);
      if (!pane.sessionId || !pane.dir) return;
      setDialog(null);
      try {
        await consoleApi.makeDirectory(pane.sessionId, joinPath(pane.dir.path, name));
        notify(`Created ${name}`);
        pane.refresh();
      } catch (failure) {
        notify(actionError(failure), "error");
      }
    },
    [notify, paneFor]
  );

  const rename = useCallback(
    async (side: PaneSide, name: string) => {
      const pane = paneFor(side);
      const [entry] = selectionOf(pane);
      if (!pane.sessionId || !pane.dir || !entry) return;
      setDialog(null);
      try {
        await consoleApi.renamePath(pane.sessionId, joinPath(pane.dir.path, entry.name), joinPath(pane.dir.path, name));
        notify(`Renamed to ${name}`);
        pane.refresh();
      } catch (failure) {
        notify(actionError(failure), "error");
      }
    },
    [notify, paneFor, selectionOf]
  );

  const remove = useCallback(
    async (side: PaneSide) => {
      const pane = paneFor(side);
      const entries = selectionOf(pane);
      if (!pane.sessionId || !pane.dir || entries.length === 0) return;
      setDialog(null);
      let deleted = 0;
      const failures: string[] = [];
      for (const entry of entries) {
        try {
          await consoleApi.deletePath(pane.sessionId, joinPath(pane.dir.path, entry.name), entry.type === "directory");
          deleted += 1;
        } catch (failure) {
          failures.push(`${entry.name}: ${actionError(failure)}`);
        }
      }
      pane.refresh();
      if (failures.length === 0) notify(`Deleted ${deleted} item${deleted === 1 ? "" : "s"}`);
      else notify(`Deleted ${deleted} of ${entries.length} — ${failures[0]}`, "error");
    },
    [notify, paneFor, selectionOf]
  );

  const openFile = useCallback((side: PaneSide, entry: RemoteFileEntry) => {
    const pane = side === "left" ? left : right;
    if (!pane.sessionId || !pane.dir) return;
    setEditor({ path: joinPath(pane.dir.path, entry.name), sessionId: pane.sessionId, side, size: entry.size });
  }, [left, right]);

  const dialogPane = dialog ? paneFor(dialog.side) : null;
  const dialogSelection = dialogPane ? selectionOf(dialogPane) : [];

  return (
    <section className="panel fm-root">
      <div className="panel-header tight">
        <div>
          <h2>Files</h2>
          <p>Two SFTP panes. Copy between hosts, rename, delete, and edit text files in place.</p>
        </div>
        {clipboard && (
          <div className="fm-clipboard" role="status">
            <Copy size={14} />
            <span>
              {clipboard.entries.length} item{clipboard.entries.length === 1 ? "" : "s"} from {clipboard.hostName}
            </span>
            <button aria-label="Clear clipboard" className="icon-button compact" onClick={() => setClipboard(null)} type="button">
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="fm-panes">
        <FilePane
          clipboard={clipboard}
          hosts={shellHosts}
          label="Left pane"
          onCopy={() => copyFrom("left")}
          onDelete={() => setDialog({ kind: "delete", side: "left" })}
          onMakeDirectory={() => setDialog({ kind: "mkdir", side: "left" })}
          onOpenFile={(entry) => openFile("left", entry)}
          onPaste={() => void pasteInto("left")}
          onRename={() => setDialog({ kind: "rename", side: "left" })}
          pane={left}
          paste={paste?.side === "left" ? paste : null}
        />
        <FilePane
          clipboard={clipboard}
          hosts={shellHosts}
          label="Right pane"
          onCopy={() => copyFrom("right")}
          onDelete={() => setDialog({ kind: "delete", side: "right" })}
          onMakeDirectory={() => setDialog({ kind: "mkdir", side: "right" })}
          onOpenFile={(entry) => openFile("right", entry)}
          onPaste={() => void pasteInto("right")}
          onRename={() => setDialog({ kind: "rename", side: "right" })}
          pane={right}
          paste={paste?.side === "right" ? paste : null}
        />
      </div>

      {dialog?.kind === "mkdir" && (
        <NamePrompt
          confirmLabel="Create folder"
          initial=""
          label="Folder name"
          onClose={() => setDialog(null)}
          onSubmit={(name) => void makeDirectory(dialog.side, name)}
          subtitle={dialogPane?.dir?.path}
          title="New folder"
        />
      )}

      {dialog?.kind === "rename" && dialogSelection[0] && (
        <NamePrompt
          confirmLabel="Rename"
          initial={dialogSelection[0].name}
          label="New name"
          onClose={() => setDialog(null)}
          onSubmit={(name) => void rename(dialog.side, name)}
          subtitle={dialogPane?.dir?.path}
          title={`Rename ${dialogSelection[0].name}`}
        />
      )}

      {dialog?.kind === "delete" && dialogSelection.length > 0 && (
        <DeletePrompt
          entries={dialogSelection}
          onClose={() => setDialog(null)}
          onConfirm={() => void remove(dialog.side)}
        />
      )}

      {editor && (
        <FileEditor
          notify={notify}
          onClose={() => setEditor(null)}
          onSaved={() => paneFor(editor.side).refresh()}
          target={editor}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- pane */

function FilePane({
  clipboard,
  hosts,
  label,
  onCopy,
  onDelete,
  onMakeDirectory,
  onOpenFile,
  onPaste,
  onRename,
  pane,
  paste
}: {
  clipboard: Clipboard | null;
  hosts: Host[];
  label: string;
  onCopy: () => void;
  onDelete: () => void;
  onMakeDirectory: () => void;
  onOpenFile: (entry: RemoteFileEntry) => void;
  onPaste: () => void;
  onRename: () => void;
  pane: Pane;
  paste: { done: number; total: number } | null;
}) {
  const entries = pane.dir?.entries ?? [];
  const selectedCount = pane.selected.length;
  const allSelected = entries.length > 0 && selectedCount === entries.length;
  const crumbs = pane.dir ? breadcrumbs(pane.dir.path) : [];
  const atRoot = !pane.dir || pane.dir.path === "/" || !pane.dir.path.startsWith("/");
  // Pasting into the directory the clipboard came from would copy onto itself.
  const pasteBlocked =
    !clipboard || (clipboard.sessionId === pane.sessionId && clipboard.path === (pane.dir?.path ?? ""));

  const onCheckClick = (entry: RemoteFileEntry) => (event: MouseEvent<HTMLInputElement>) => {
    if (!event.shiftKey) return;
    // Handled here instead of onChange because only the mouse event carries the
    // modifier that turns a click into a range selection.
    event.preventDefault();
    pane.toggle(entry.name, true);
  };

  return (
    <section aria-label={label} className={cx("fm-pane", pane.sessionId && "is-live")}>
      <header className="fm-pane-head">
        <span className="fm-pane-label">{label}</span>
        <select
          aria-label={`${label} host`}
          className="fm-host-select"
          disabled={pane.starting}
          onChange={(event) => {
            const next = hosts.find((host) => host.id === event.target.value);
            if (next) pane.attach(next);
            else pane.release();
          }}
          value={pane.host?.id ?? ""}
        >
          <option value="">{hosts.length === 0 ? "No SSH hosts" : "Pick a host…"}</option>
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
            </option>
          ))}
        </select>
        <span aria-live="polite" className="fm-pane-status">
          {pane.starting ? (
            <>
              <Loader2 className="spin" size={13} /> connecting…
            </>
          ) : pane.busy ? (
            <>
              <Loader2 className="spin" size={13} /> loading…
            </>
          ) : pane.dir ? (
            `${entries.length} item${entries.length === 1 ? "" : "s"}`
          ) : (
            ""
          )}
        </span>
        <button
          aria-label={`Refresh ${label}`}
          className="icon-button compact"
          disabled={!pane.sessionId || pane.busy}
          onClick={pane.refresh}
          type="button"
        >
          <RefreshCw size={14} />
        </button>
        <button
          aria-label={`Disconnect ${label}`}
          className="icon-button compact"
          disabled={!pane.sessionId}
          onClick={pane.release}
          type="button"
        >
          <Unplug size={14} />
        </button>
      </header>

      {!pane.sessionId ? (
        <div className="fm-pane-empty">
          {pane.starting ? (
            <>
              <Loader2 className="spin" size={24} />
              <strong>Opening a file session…</strong>
            </>
          ) : (
            <>
              <FolderLock size={24} />
              <strong>No file session</strong>
              <span>
                {hosts.length === 0
                  ? "Add an SSH host first — file sessions run over SSH."
                  : `Pick a host in the ${label.toLowerCase()} header to browse its files.`}
              </span>
            </>
          )}
          {pane.error && <span className="fm-pane-empty-error">{pane.error}</span>}
        </div>
      ) : (
        <>
          <form
            className="fm-pathbar"
            onSubmit={(event) => {
              event.preventDefault();
              pane.jump(pane.pathDraft);
            }}
          >
            <input
              aria-invalid={pane.error ? true : undefined}
              aria-label={`${label} path`}
              className="fm-path-input"
              onChange={(event) => pane.setPathDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") pane.resetDraft();
              }}
              placeholder="/var/www"
              spellCheck={false}
              value={pane.pathDraft}
            />
            <button className="secondary-button fm-go" type="submit">
              Go
            </button>
          </form>

          <div className="fm-crumbs">
            <button
              aria-label={`${label}: up one level`}
              className="icon-button compact"
              disabled={atRoot || pane.busy}
              onClick={() => pane.dir && pane.jump(parentPath(pane.dir.path))}
              type="button"
            >
              <ArrowUp size={14} />
            </button>
            <nav aria-label={`${label} breadcrumb`} className="fm-crumb-track">
              {crumbs.map((crumb, index) => (
                <span className="fm-crumb" key={crumb.path}>
                  {index > 0 && <ChevronRight aria-hidden size={12} />}
                  <button
                    aria-current={index === crumbs.length - 1 ? "location" : undefined}
                    className="fm-crumb-link"
                    disabled={index === crumbs.length - 1}
                    onClick={() => pane.jump(crumb.path)}
                    type="button"
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          </div>

          <div className="fm-tools">
            <button className="secondary-button fm-tool" disabled={selectedCount === 0} onClick={onCopy} type="button">
              <Copy size={14} />
              Copy
            </button>
            <button
              className="secondary-button fm-tool"
              disabled={pasteBlocked || paste !== null}
              onClick={onPaste}
              type="button"
            >
              <ClipboardPaste size={14} />
              Paste
            </button>
            <button
              className="secondary-button fm-tool"
              disabled={selectedCount !== 1}
              onClick={onRename}
              type="button"
            >
              <Pencil size={14} />
              Rename
            </button>
            <button className="secondary-button fm-tool" onClick={onMakeDirectory} type="button">
              <FolderPlus size={14} />
              New folder
            </button>
            <button
              className="danger-button fm-tool"
              disabled={selectedCount === 0}
              onClick={onDelete}
              type="button"
            >
              <Trash2 size={14} />
              Delete
            </button>
            <span className="fm-selection-count">
              {selectedCount > 0
                ? `${selectedCount} selected`
                : "Tick rows (shift for a range) to copy, rename, or delete"}
            </span>
          </div>

          {pane.error && (
            <p className="fm-error" role="alert">
              <AlertTriangle size={15} />
              {pane.error}
            </p>
          )}

          {paste && (
            <p aria-live="polite" className="fm-progress">
              <Loader2 className="spin" size={14} />
              Pasting {Math.min(paste.done + 1, paste.total)} of {paste.total}…
            </p>
          )}

          <div className="fm-list-head">
            <label className="fm-check-cell">
              <input
                aria-label={`Select every entry in ${label}`}
                checked={allSelected}
                disabled={entries.length === 0}
                onChange={(event) => pane.selectAll(event.target.checked)}
                type="checkbox"
              />
            </label>
            <span>Name</span>
            <span className="fm-col-size">Size</span>
            <span className="fm-col-time">Modified</span>
          </div>

          <ul className="fm-list">
            {entries.map((entry) => {
              const selected = pane.selected.includes(entry.name);
              return (
                <li className={cx("fm-row", selected && "is-selected")} key={entry.name}>
                  <label className="fm-check-cell">
                    <input
                      aria-label={`Select ${entry.name}`}
                      checked={selected}
                      onChange={() => pane.toggle(entry.name, false)}
                      onClick={onCheckClick(entry)}
                      type="checkbox"
                    />
                  </label>
                  <button
                    className="fm-row-main"
                    disabled={entry.type === "other"}
                    onClick={(event) => {
                      // Ctrl/Cmd-click and shift-click are the familiar "add to
                      // selection" gestures; a plain click navigates or edits.
                      if (event.ctrlKey || event.metaKey) pane.toggle(entry.name, false);
                      else if (event.shiftKey) pane.toggle(entry.name, true);
                      else if (entry.type === "directory") {
                        if (pane.dir) pane.jump(joinPath(pane.dir.path, entry.name));
                      } else onOpenFile(entry);
                    }}
                    title={entry.type === "directory" ? `Open ${entry.name}` : `Edit ${entry.name}`}
                    type="button"
                  >
                    {entry.type === "directory" ? (
                      <Folder className="fm-icon-dir" size={15} />
                    ) : (
                      <FileIcon size={15} />
                    )}
                    <span className="fm-row-name">{entry.name}</span>
                  </button>
                  <span className="fm-col-size">{entry.type === "directory" ? "—" : formatBytes(entry.size)}</span>
                  <span className="fm-col-time">{formatModified(entry.modifiedAt)}</span>
                </li>
              );
            })}
            {entries.length === 0 && !pane.busy && (
              <li className="fm-empty-row">
                <Folder size={16} />
                {pane.dir ? "This directory is empty." : "Nothing loaded yet."}
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}
