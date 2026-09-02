import { useMemo, useState } from "react";
import type { TaskItem } from "@onshell/api-client";
import { bridge } from "../bridge.js";
import { Icon } from "../icons.js";

export function Tasks({ initial }: { initial: TaskItem[] }) {
  const [tasks, setTasks] = useState(initial);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "all" | "completed">("active");
  const visible = useMemo(() => tasks.filter((task) =>
    (filter === "all" || (filter === "completed" ? task.completed : !task.completed)) &&
    task.text.toLowerCase().includes(query.trim().toLowerCase())), [tasks, query, filter]);
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    const text = String(new FormData(form).get("task") ?? "").trim(); if (!text) return;
    const task = await bridge.console.createTask(text); setTasks((current) => [task, ...current]); form.reset();
  }
  async function toggle(task: TaskItem) {
    const next = await bridge.console.updateTask(task.id, { completed: !task.completed });
    setTasks((current) => current.map((item) => item.id === next.id ? next : item));
  }
  async function remove(task: TaskItem) { await bridge.console.deleteTask(task.id); setTasks((current) => current.filter((item) => item.id !== task.id)); }
  return <section className="desktop-tasks">
    <header><div><p>Productivity</p><h1>Tasks</h1><span>Synced with your Onshell web workspace.</span></div></header>
    <form className="desktop-task-compose" onSubmit={(event) => void add(event)}><Icon name="tasks" size={17}/><input name="task" placeholder="Add a task…" maxLength={2000} aria-label="New task"/><button className="button button--primary" type="submit"><Icon name="plus" size={14}/>Add</button></form>
    <div className="desktop-task-tools"><label><Icon name="search" size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks"/></label><div>{(["active","all","completed"] as const).map((value) => <button className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)} key={value}>{value}</button>)}</div></div>
    <div className="desktop-task-list">{visible.map((task) => <article className={task.completed ? "is-completed" : ""} key={task.id}><button className="desktop-task-check" onClick={() => void toggle(task)} aria-label={task.completed ? "Mark active" : "Mark complete"}>{task.completed && "✓"}</button><p>{task.text}</p><button className="icon icon--danger" onClick={() => void remove(task)} aria-label="Delete task"><Icon name="close" size={13}/></button></article>)}{visible.length === 0 && <div className="resource-empty"><strong>No tasks here</strong><p>Add a task or change the filter.</p></div>}</div>
  </section>;
}
