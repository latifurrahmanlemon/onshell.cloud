"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteColor, NoteInput, NoteItem, NoteRevision } from "@onshell/api-client";
import { useLiveRefresh } from "./live-refresh";
import "./notebook.css";

/**
 * A Keep-style notebook: quick capture, colour-coded cards, pinning, archive
 * and trash, with every change kept as a restorable revision on the server.
 *
 * The same component ships in the desktop app; only the `api` binding differs.
 */
export interface NotebookApi {
  notes(): Promise<NoteItem[]>;
  createNote(input: NoteInput): Promise<NoteItem>;
  updateNote(id: string, input: NoteInput): Promise<NoteItem>;
  deleteNote(id: string): Promise<unknown>;
  noteHistory(id: string): Promise<NoteRevision[]>;
}

const COLORS: Array<{ value: NoteColor; label: string }> = [
  { value: "default", label: "Default" },
  { value: "red", label: "Coral" },
  { value: "orange", label: "Peach" },
  { value: "yellow", label: "Sand" },
  { value: "green", label: "Mint" },
  { value: "teal", label: "Sage" },
  { value: "blue", label: "Fog" },
  { value: "purple", label: "Dusk" },
  { value: "pink", label: "Blossom" },
  { value: "gray", label: "Clay" }
];

const ACTION_LABELS: Record<NoteRevision["action"], string> = {
  created: "Created",
  edited: "Edited",
  pinned: "Pinned",
  unpinned: "Unpinned",
  archived: "Archived",
  unarchived: "Unarchived",
  trashed: "Moved to trash",
  restored: "Restored from trash",
  recolored: "Colour changed"
};

type Folder = "notes" | "archive" | "trash";
interface Draft { title: string; body: string; color: NoteColor; pinned: boolean }
const emptyDraft: Draft = { title: "", body: "", color: "default", pinned: false };

function relativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["minute", 60], ["hour", 3600], ["day", 86400], ["week", 604800], ["month", 2629800], ["year", 31557600]];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0];
  for (const unit of units) if (seconds >= unit[1]) chosen = unit;
  return format.format(-Math.round(seconds / chosen[1]), chosen[0]);
}

function Glyph({ name }: { name: "pin" | "palette" | "archive" | "unarchive" | "trash" | "restore" | "history" | "close" | "delete" }) {
  const paths: Record<typeof name, string> = {
    pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v7",
    palette: "M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.1-4-7.6-9-7.6ZM7.5 11.5h.01M10 7.5h.01M14 7.5h.01M16.5 11h.01",
    archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
    unarchive: "M3 4h18v4H3zM5 8v12h14V8M12 18v-6M9 14l3-3 3 3",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    restore: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
    history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
    close: "M6 6l12 12M18 6 6 18",
    delete: "M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3M10 11l4 4M14 11l-4 4"
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill={name === "pin" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} fillOpacity={name === "pin" ? 0.18 : undefined}/></svg>;
}

function ColorPicker({ value, onChange }: { value: NoteColor; onChange: (color: NoteColor) => void }) {
  return <div className="nb-colors" role="radiogroup" aria-label="Note colour">
    {COLORS.map((color) => <button key={color.value} type="button" role="radio" aria-checked={value === color.value} aria-label={color.label} title={color.label} className={`nb-swatch nb-color-${color.value}`} onClick={() => onChange(color.value)}/>)}
  </div>;
}

export function Notebook({ api, initial = [] }: { api: NotebookApi; initial?: NoteItem[] }) {
  const [notes, setNotes] = useState<NoteItem[]>(initial);
  const [folder, setFolder] = useState<Folder>("notes");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<NoteItem>();
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [palette, setPalette] = useState<string>();
  const [history, setHistory] = useState<{ note: NoteItem; revisions?: NoteRevision[]; selected?: string; error?: string }>();
  const [purging, setPurging] = useState<NoteItem | "all">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const busyRef = useRef(false);
  const generation = useRef(0);
  const composer = useRef<HTMLFormElement>(null);

  const load = async () => {
    const version = generation.current;
    const next = await api.notes();
    if (!busyRef.current && version === generation.current) setNotes(next);
  };
  useEffect(() => { void load().catch(() => setError("Could not load notes. Check your connection.")); }, []);
  useLiveRefresh(load);

  async function mutate(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; generation.current++; setBusy(true); setError(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the note. Try again."); }
    finally { busyRef.current = false; generation.current++; setBusy(false); }
  }
  const replace = (next: NoteItem) => setNotes((items) => items.some((item) => item.id === next.id) ? items.map((item) => item.id === next.id ? next : item) : [next, ...items]);
  const update = (note: NoteItem, input: NoteInput) => mutate(async () => { replace(await api.updateNote(note.id, input)); });

  const counts = useMemo(() => ({
    notes: notes.filter((note) => !note.trashed && !note.archived).length,
    archive: notes.filter((note) => !note.trashed && note.archived).length,
    trash: notes.filter((note) => note.trashed).length,
    pinned: notes.filter((note) => !note.trashed && !note.archived && note.pinned).length
  }), [notes]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes
      .filter((note) => folder === "trash" ? note.trashed : !note.trashed && (folder === "archive") === note.archived)
      .filter((note) => !needle || `${note.title}\n${note.body}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [notes, folder, query]);
  const pinned = folder === "notes" ? visible.filter((note) => note.pinned) : [];
  const others = folder === "notes" ? visible.filter((note) => !note.pinned) : visible;

  function saveComposer() {
    const title = draft.title.trim(), body = draft.body;
    setComposing(false);
    if (!title && !body.trim()) { setDraft(emptyDraft); return; }
    void mutate(async () => {
      const note = await api.createNote({ ...draft, title, body });
      replace(note);
      setDraft(emptyDraft);
    });
  }
  useEffect(() => {
    if (!composing) return;
    const outside = (event: MouseEvent) => { if (composer.current && !composer.current.contains(event.target as Node)) saveComposer(); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  });

  function openEditor(note: NoteItem) {
    setEditing(note);
    setEditDraft({ title: note.title, body: note.body, color: note.color, pinned: note.pinned });
  }
  function closeEditor() {
    const note = editing;
    setEditing(undefined);
    if (!note || note.trashed) return;
    const input: NoteInput = {};
    if (editDraft.title.trim() !== note.title) input.title = editDraft.title.trim();
    if (editDraft.body !== note.body) input.body = editDraft.body;
    if (editDraft.color !== note.color) input.color = editDraft.color;
    if (editDraft.pinned !== note.pinned) input.pinned = editDraft.pinned;
    if (!Object.keys(input).length) return;
    if (!editDraft.title.trim() && !editDraft.body.trim()) { setError("An empty note was not saved. Add a title or text, or move it to trash."); return; }
    void update(note, input);
  }

  async function openHistory(note: NoteItem) {
    setHistory({ note });
    try {
      const revisions = await api.noteHistory(note.id);
      setHistory((current) => current?.note.id === note.id ? { note, revisions, selected: revisions[0]?.id } : current);
    } catch {
      setHistory((current) => current?.note.id === note.id ? { note, error: note.id.startsWith("offline-") ? "History becomes available once this note has synced." : "Could not load the history. Check your connection." } : current);
    }
  }
  const selectedRevision = history?.revisions?.find((revision) => revision.id === history.selected);

  function card(note: NoteItem) {
    return <article key={note.id} className={`nb-card nb-color-${note.color}${note.pinned && !note.trashed ? " is-pinned" : ""}`}>
      <button type="button" className="nb-card-open" onClick={() => note.trashed ? undefined : openEditor(note)} aria-label={`Open ${note.title || "note"}`} disabled={note.trashed}>
        {note.title && <h3>{note.title}</h3>}
        {note.body && <p>{note.body}</p>}
        <small title={new Date(note.updatedAt).toLocaleString()}>Edited {relativeTime(note.updatedAt)}</small>
      </button>
      {!note.trashed && <button type="button" className={`nb-pin${note.pinned ? " is-active" : ""}`} aria-pressed={note.pinned} aria-label={note.pinned ? "Unpin note" : "Pin note"} title={note.pinned ? "Unpin" : "Pin"} disabled={busy} onClick={() => void update(note, { pinned: !note.pinned })}><Glyph name="pin"/></button>}
      <footer className="nb-actions">
        {note.trashed ? <>
          <button type="button" disabled={busy} title="Restore" aria-label="Restore note" onClick={() => void update(note, { trashed: false })}><Glyph name="restore"/></button>
          <button type="button" disabled={busy} title="Delete forever" aria-label="Delete note forever" onClick={() => setPurging(note)}><Glyph name="delete"/></button>
        </> : <>
          <span className="nb-palette-anchor">
            <button type="button" disabled={busy} title="Background colour" aria-label="Change colour" aria-expanded={palette === note.id} onClick={() => setPalette(palette === note.id ? undefined : note.id)}><Glyph name="palette"/></button>
            {palette === note.id && <div className="nb-palette-pop"><ColorPicker value={note.color} onChange={(color) => { setPalette(undefined); void update(note, { color }); }}/></div>}
          </span>
          <button type="button" disabled={busy} title={note.archived ? "Unarchive" : "Archive"} aria-label={note.archived ? "Unarchive note" : "Archive note"} onClick={() => void update(note, { archived: !note.archived })}><Glyph name={note.archived ? "unarchive" : "archive"}/></button>
          <button type="button" title="Version history" aria-label="Version history" onClick={() => void openHistory(note)}><Glyph name="history"/></button>
          <button type="button" disabled={busy} title="Move to trash" aria-label="Move note to trash" onClick={() => void update(note, { trashed: true })}><Glyph name="trash"/></button>
        </>}
      </footer>
    </article>;
  }

  return <section className="nb">
    <header className="nb-hero">
      <div><p>Workspace notebook</p><h1>Notebook</h1><span>Capture ideas, runbooks and reminders. Every change is versioned and synced across web and desktop.</span></div>
      <dl className="nb-stats">
        <div><dt>Notes</dt><dd>{counts.notes}</dd></div>
        <div><dt>Pinned</dt><dd>{counts.pinned}</dd></div>
        <div><dt>Archived</dt><dd>{counts.archive}</dd></div>
      </dl>
    </header>

    {error && <div role="alert" className="nb-error"><span>{error}</span><button type="button" onClick={() => setError(undefined)} aria-label="Dismiss notebook error">×</button></div>}

    <div className="nb-toolbar">
      <div className="nb-folders" role="tablist" aria-label="Notebook folders">
        {(["notes", "archive", "trash"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={folder === value} className={folder === value ? "is-active" : ""} onClick={() => setFolder(value)}>{value === "notes" ? "Notes" : value === "archive" ? "Archive" : "Trash"}<span>{counts[value]}</span></button>)}
      </div>
      <input className="nb-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" aria-label="Search notes"/>
    </div>

    {folder === "notes" && <form ref={composer} className={`nb-compose nb-color-${draft.color}${composing ? " is-open" : ""}`} onSubmit={(event) => { event.preventDefault(); saveComposer(); }}>
      {composing && <div className="nb-compose-head"><input value={draft.title} maxLength={200} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Title" aria-label="Note title"/><button type="button" className={`nb-pin${draft.pinned ? " is-active" : ""}`} aria-pressed={draft.pinned} aria-label="Pin note" title="Pin" onClick={() => setDraft({ ...draft, pinned: !draft.pinned })}><Glyph name="pin"/></button></div>}
      <textarea value={draft.body} maxLength={20000} rows={composing ? 4 : 1} onFocus={() => setComposing(true)} onChange={(event) => setDraft({ ...draft, body: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") saveComposer(); if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) saveComposer(); }} placeholder="Take a note…" aria-label="Note text"/>
      {composing && <div className="nb-compose-foot"><ColorPicker value={draft.color} onChange={(color) => setDraft({ ...draft, color })}/><button type="submit" className="nb-primary" disabled={busy}>Close</button></div>}
    </form>}

    {folder === "trash" && counts.trash > 0 && <div className="nb-trash-bar"><span>Notes in trash can be restored until you delete them forever.</span><button type="button" disabled={busy} onClick={() => setPurging("all")}>Empty trash</button></div>}

    {pinned.length > 0 && <><h2 className="nb-section">Pinned</h2><div className="nb-grid">{pinned.map(card)}</div></>}
    {pinned.length > 0 && others.length > 0 && <h2 className="nb-section">Others</h2>}
    {others.length > 0 && <div className="nb-grid">{others.map(card)}</div>}
    {!visible.length && <div className="nb-empty"><strong>{query ? "No matching notes" : folder === "archive" ? "No archived notes" : folder === "trash" ? "Trash is empty" : "Notes you add appear here"}</strong><p>{query ? "Try another search." : folder === "notes" ? "Click “Take a note…” above to capture your first idea." : folder === "archive" ? "Archive notes to keep them out of the way without deleting them." : "Deleted notes land here first."}</p></div>}

    {editing && <div className="nb-modal" role="dialog" aria-modal="true" aria-label="Edit note" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
      <div className={`nb-editor nb-color-${editDraft.color}`}>
        <div className="nb-compose-head"><input autoFocus value={editDraft.title} maxLength={200} onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })} placeholder="Title" aria-label="Note title"/><button type="button" className={`nb-pin${editDraft.pinned ? " is-active" : ""}`} aria-pressed={editDraft.pinned} aria-label="Pin note" title="Pin" onClick={() => setEditDraft({ ...editDraft, pinned: !editDraft.pinned })}><Glyph name="pin"/></button></div>
        <textarea value={editDraft.body} maxLength={20000} rows={12} onChange={(event) => setEditDraft({ ...editDraft, body: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") closeEditor(); }} placeholder="Note" aria-label="Note text"/>
        <small className="nb-meta">Created {new Date(editing.createdAt).toLocaleString()} · Edited {relativeTime(editing.updatedAt)}</small>
        <div className="nb-compose-foot">
          <ColorPicker value={editDraft.color} onChange={(color) => setEditDraft({ ...editDraft, color })}/>
          <div className="nb-editor-actions">
            <button type="button" title="Version history" onClick={() => { const note = editing; closeEditor(); void openHistory(note); }}><Glyph name="history"/> History</button>
            <button type="button" title="Move to trash" disabled={busy} onClick={() => { const note = editing; setEditing(undefined); void update(note, { trashed: true }); }}><Glyph name="trash"/></button>
            <button type="button" className="nb-primary" onClick={closeEditor}>Close</button>
          </div>
        </div>
      </div>
    </div>}

    {history && <div className="nb-modal" role="dialog" aria-modal="true" aria-label="Version history" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistory(undefined); }}>
      <div className="nb-history">
        <header><div><h2>Version history</h2><p>{history.note.title || "Untitled note"}</p></div><button type="button" aria-label="Close history" onClick={() => setHistory(undefined)}><Glyph name="close"/></button></header>
        {history.error ? <div className="nb-empty"><strong>History unavailable</strong><p>{history.error}</p></div>
          : !history.revisions ? <div className="nb-empty"><p>Loading history…</p></div>
          : <div className="nb-history-body">
            <ol className="nb-timeline">{history.revisions.map((revision, index) => <li key={revision.id}><button type="button" className={history.selected === revision.id ? "is-active" : ""} onClick={() => setHistory({ ...history, selected: revision.id })}>
              <strong>{ACTION_LABELS[revision.action] ?? revision.action}{index === 0 && <em>Current</em>}</strong>
              <span>{new Date(revision.createdAt).toLocaleString()}</span>
              <small>by {revision.actorName}</small>
            </button></li>)}</ol>
            {selectedRevision && <div className={`nb-preview nb-color-${selectedRevision.color}`}>
              {selectedRevision.title && <h3>{selectedRevision.title}</h3>}
              <p>{selectedRevision.body || <em>No text</em>}</p>
              <footer>
                <span>{[selectedRevision.pinned && "Pinned", selectedRevision.archived && "Archived", selectedRevision.trashed && "In trash"].filter(Boolean).join(" · ") || "Active"}</span>
                {selectedRevision.id !== history.revisions[0]?.id && !history.note.trashed && <button type="button" className="nb-primary" disabled={busy} onClick={() => { const note = history.note; setHistory(undefined); void update(note, { title: selectedRevision.title, body: selectedRevision.body, color: selectedRevision.color }); }}>Restore this version</button>}
              </footer>
            </div>}
          </div>}
      </div>
    </div>}

    {purging && <div className="nb-modal" role="dialog" aria-modal="true" aria-label="Delete forever">
      <div className="nb-confirm">
        <h2>{purging === "all" ? "Empty trash?" : "Delete note forever?"}</h2>
        <p>{purging === "all" ? `All ${counts.trash} notes in trash and their version history will be permanently deleted.` : "This note and its version history will be permanently deleted. This cannot be undone."}</p>
        <div><button type="button" disabled={busy} onClick={() => setPurging(undefined)}>Cancel</button><button type="button" className="nb-danger" disabled={busy} onClick={() => void mutate(async () => {
          const targets = purging === "all" ? notes.filter((note) => note.trashed) : [purging];
          for (const note of targets) { await api.deleteNote(note.id); setNotes((items) => items.filter((item) => item.id !== note.id)); }
          setPurging(undefined);
        })}>Delete forever</button></div>
      </div>
    </div>}
  </section>;
}
