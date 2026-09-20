import { useEffect, useRef, useState } from "react";
import type { TaskItem } from "@onshell/api-client";
import { bridge } from "../bridge.js";
import { useLiveRefresh } from "../live-refresh.js";

export function Tasks({ initial }: { initial: TaskItem[] }) {
  const [tasks, setTasks] = useState<TaskItem[]>(initial);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "all" | "completed">("active");
  const [sort, setSort] = useState("newest");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<TaskItem>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const [error, setError] = useState<string>();
  const load = async () => {
    const version = generation.current;
    const next = await bridge.console.tasks();
    if (!busyRef.current && version === generation.current) setTasks(next);
  };
  useEffect(() => { void load().catch(() => setError("Could not load tasks. Check your connection.")); }, []);
  useLiveRefresh(load);
  const done = tasks.filter((item) => item.completed).length;
  const visible = tasks.filter((item) => (filter === "all" || (filter === "completed" ? item.completed : !item.completed)) && item.text.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => sort === "name" ? a.text.localeCompare(b.text) : sort === "oldest" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt));
  async function mutate(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; generation.current++; setBusy(true); setError(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the task. Try again."); }
    finally { busyRef.current = false; generation.current++; setBusy(false); }
  }
  const toggle = (task: TaskItem) => mutate(async () => {
    const next = await bridge.console.updateTask(task.id, { completed: !task.completed });
    setTasks((items) => items.map((item) => item.id === next.id ? next : item));
  });
  return <section className="desktop-tasks">
    <header><div><p>Workspace planner</p><h1>Tasks</h1><span>Your personal task queue, synced across web and desktop.</span></div></header>
    <div className="task-summary"><span><strong>{tasks.length - done}</strong> Open</span><span><strong>{done}</strong> Done</span><span><strong>{tasks.length}</strong> Total</span></div>
    <progress className="task-completion" max={Math.max(tasks.length, 1)} value={done} aria-label="Task completion"/>
    {error && <div role="alert" className="task-error"><span>{error}</span><button type="button" onClick={() => setError(undefined)} aria-label="Dismiss task error">×</button></div>}
    <form className="task-compose desktop-task-compose" onSubmit={(event) => { event.preventDefault(); const submitted = text.trim(); if (!submitted) return; void mutate(async () => { const task = await bridge.console.createTask(submitted); setTasks((items) => [task, ...items]); setText((current) => current.trim() === submitted ? "" : current); }); }}>
      <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} placeholder="What needs to get done?" aria-label="New task"/><button className="button button--primary" disabled={busy || !text.trim()} type="submit">Add task</button>
    </form>
    <div className="task-tools desktop-task-tools"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks"/><div className="task-filters">{(["active", "all", "completed"] as const).map((value) => <button type="button" className={filter === value ? "is-active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)} key={value}>{value} ({value === "active" ? tasks.length - done : value === "completed" ? done : tasks.length})</button>)}</div><select aria-label="Sort tasks" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Alphabetical</option></select></div>
    <div className="task-list desktop-task-list">{visible.map((task) => <article className={task.completed ? "is-completed" : ""} key={task.id}>
      <button type="button" className="task-check desktop-task-check" disabled={busy} aria-label={task.completed ? "Mark active" : "Mark complete"} aria-pressed={task.completed} onClick={() => void toggle(task)}>{task.completed ? "✓" : ""}</button>
      {editing === task.id ? <form className="task-inline-edit" onSubmit={(event) => { event.preventDefault(); if (!draft.trim()) return; void mutate(async () => { const next = await bridge.console.updateTask(task.id, { text: draft.trim() }); setTasks((items) => items.map((item) => item.id === task.id ? next : item)); setEditing(undefined); }); }}><input autoFocus aria-label="Edit task text" maxLength={2000} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(undefined); }}/><button disabled={busy || !draft.trim()} type="submit">Save</button><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>Cancel</button></form> : <div className="task-text"><p>{task.text}</p><small>{task.completed ? "Completed" : "Added"} {new Date(task.completedAt ?? task.createdAt).toLocaleDateString()}</small></div>}
      <button type="button" disabled={busy} aria-label={`Edit ${task.text}`} onClick={() => { setEditing(task.id); setDraft(task.text); }}>Edit</button><button type="button" disabled={busy} aria-label={`Delete ${task.text}`} onClick={() => setDeleting(task)}>Delete</button>
    </article>)}{!visible.length && <div className="resource-empty"><strong>{query ? "No matching tasks" : filter === "completed" ? "No completed tasks yet" : "Your queue is clear"}</strong><p>{query ? "Try another search or filter." : "Add a task above when something needs your attention."}</p></div>}</div>
    {deleting && <div className="task-delete-confirm" role="dialog" aria-modal="true" aria-label="Delete task"><div><h2>Delete task?</h2><p>{deleting.text}</p>{error && <p role="alert">{error}</p>}<button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>Cancel</button><button type="button" disabled={busy} onClick={() => void mutate(async () => { await bridge.console.deleteTask(deleting.id); setTasks((items) => items.filter((item) => item.id !== deleting.id)); setDeleting(undefined); })}>Delete task</button></div></div>}
  </section>;
}
