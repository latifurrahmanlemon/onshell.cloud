"use client";

import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Activity, Archive, CalendarPlus, CheckCircle2, CircleDot, History, ListTodo, NotebookPen, Pin, RefreshCw, Search, Trash2, Users } from "lucide-react";
import { cx } from "@onshell/ui";
import { apiGet, errorText, formatDateTime } from "./lib";
import "./productivity.css";

interface UsageRow {
  userId: string;
  name: string;
  email: string;
  organizationName: string | null;
  lastLoginAt: string | null;
  total: number;
  firstCreatedAt: string | null;
  lastActivityAt: string | null;
  [count: string]: string | number | null;
}

interface UsageResponse {
  totals: Record<string, number>;
  users: UsageRow[];
}

interface Column { key: string; label: string }
interface Kpi { key: string; label: string; icon: LucideIcon; hint?: string }

interface Config {
  noun: string;
  path: string;
  icon: LucideIcon;
  kpis: Kpi[];
  columns: Column[];
  /** Renders a per-user share bar from these two counts, e.g. completed of total. */
  ratio?: { part: string; label: string };
}

const configs: Record<"tasks" | "notes", Config> = {
  tasks: {
    noun: "task",
    path: "/admin/tasks/summary",
    icon: ListTodo,
    kpis: [
      { key: "total", label: "Total tasks", icon: ListTodo },
      { key: "open", label: "Open", icon: CircleDot },
      { key: "completed", label: "Completed", icon: CheckCircle2 },
      { key: "users", label: "Users with tasks", icon: Users },
      { key: "active7d", label: "Active last 7 days", icon: Activity, hint: "users" },
      { key: "createdThisWeek", label: "Added last 7 days", icon: CalendarPlus }
    ],
    columns: [
      { key: "total", label: "Tasks" },
      { key: "open", label: "Open" },
      { key: "completed", label: "Done" }
    ],
    ratio: { part: "completed", label: "Completion" }
  },
  notes: {
    noun: "note",
    path: "/admin/notes/summary",
    icon: NotebookPen,
    kpis: [
      { key: "total", label: "Total notes", icon: NotebookPen },
      { key: "pinned", label: "Pinned", icon: Pin },
      { key: "archived", label: "Archived", icon: Archive },
      { key: "trashed", label: "In trash", icon: Trash2 },
      { key: "changes", label: "Recorded changes", icon: History },
      { key: "users", label: "Users with notes", icon: Users },
      { key: "active7d", label: "Active last 7 days", icon: Activity, hint: "users" },
      { key: "createdThisWeek", label: "Added last 7 days", icon: CalendarPlus }
    ],
    columns: [
      { key: "total", label: "Notes" },
      { key: "active", label: "Active" },
      { key: "pinned", label: "Pinned" },
      { key: "archived", label: "Archived" },
      { key: "trashed", label: "Trash" },
      { key: "changes", label: "Changes" }
    ]
  }
};

type SortKey = "name" | "lastActivityAt" | "firstCreatedAt" | string;

function relative(value: string | null) {
  if (!value) return "Never";
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

function freshness(value: string | null) {
  if (!value) return "rose";
  const days = (Date.now() - new Date(value).getTime()) / 86400000;
  return days <= 7 ? "green" : days <= 30 ? "amber" : "rose";
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function ProductivitySection({ kind }: { kind: "tasks" | "notes" }) {
  const config = configs[kind];
  const [data, setData] = useState<UsageResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [activity, setActivity] = useState<"all" | "7" | "30" | "stale">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "lastActivityAt", dir: "desc" });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void apiGet<UsageResponse>(config.path)
      .then((next) => { if (active) setData(next); })
      .catch((cause) => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [config.path, revision]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const now = Date.now();
    const age = (row: UsageRow) => row.lastActivityAt ? (now - new Date(row.lastActivityAt).getTime()) / 86400000 : Infinity;
    return (data?.users ?? [])
      .filter((row) => !needle || `${row.name} ${row.email} ${row.organizationName ?? ""}`.toLowerCase().includes(needle))
      .filter((row) => activity === "all" || (activity === "stale" ? age(row) > 30 : age(row) <= Number(activity)))
      .sort((left, right) => {
        const a = left[sort.key], b = right[sort.key];
        const order = typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""));
        return sort.dir === "asc" ? order : -order;
      });
  }, [data, query, activity, sort]);

  const toggleSort = (key: SortKey) => setSort((current) => current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" });
  const arrow = (key: SortKey) => sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : "";

  function exportCsv() {
    const header = ["Name", "Email", "Organization", ...config.columns.map((column) => column.label), "First added", "Last used", "Last sign-in"];
    const lines = rows.map((row) => [row.name, row.email, row.organizationName, ...config.columns.map((column) => row[column.key]), row.firstCreatedAt, row.lastActivityAt, row.lastLoginAt].map(csvCell).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `onshell-${kind}-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const Icon = config.icon;
  return (
    <div className="adm-stack">
      <div className="prod-kpis">
        {config.kpis.map((kpi) => (
          <article key={kpi.key} className="prod-kpi">
            <span><kpi.icon aria-hidden="true" size={17} /></span>
            <div><small>{kpi.label}</small><strong>{loading && !data ? "—" : (data?.totals[kpi.key] ?? 0).toLocaleString()}</strong></div>
          </article>
        ))}
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Usage by user</h2>
            <p>How many {config.noun}s each person has added and when they last used the feature.</p>
          </div>
          <div className="adm-users-toolbar prod-tools">
            <div className="search-field">
              <Search size={15} />
              <input aria-label={`Search ${config.noun} users`} placeholder="Name, email, organization…" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <select aria-label="Filter by last activity" value={activity} onChange={(event) => setActivity(event.target.value as typeof activity)}>
              <option value="all">Any activity</option>
              <option value="7">Active in 7 days</option>
              <option value="30">Active in 30 days</option>
              <option value="stale">Inactive 30+ days</option>
            </select>
            <button className="adm-link-button" disabled={!rows.length} onClick={exportCsv} type="button">Export CSV</button>
            <button aria-label={`Refresh ${config.noun} usage`} className="icon-button" disabled={loading} onClick={() => setRevision((value) => value + 1)} type="button">
              <RefreshCw className={cx(loading && "adm-spin")} size={15} />
            </button>
          </div>
        </div>

        {error ? (
          <div className="prod-state" role="alert"><strong>Could not load usage.</strong><span>{error}</span><button className="adm-link-button" onClick={() => setRevision((value) => value + 1)} type="button">Retry</button></div>
        ) : loading && !data ? (
          <div className="prod-state" role="status">Loading usage…</div>
        ) : !rows.length ? (
          <div className="prod-state"><Icon aria-hidden="true" size={24} /><strong>{data?.users.length ? "No users match these filters" : `No ${config.noun}s yet`}</strong><span>{data?.users.length ? "Try clearing the search or activity filter." : `Users appear here once they add their first ${config.noun}.`}</span></div>
        ) : (
          <div className="prod-table-wrap">
            <table className="prod-table">
              <thead>
                <tr>
                  <th><button type="button" onClick={() => toggleSort("name")}>User{arrow("name")}</button></th>
                  {config.columns.map((column) => <th key={column.key} className="num"><button type="button" onClick={() => toggleSort(column.key)}>{column.label}{arrow(column.key)}</button></th>)}
                  {config.ratio && <th>{config.ratio.label}</th>}
                  <th><button type="button" onClick={() => toggleSort("firstCreatedAt")}>First added{arrow("firstCreatedAt")}</button></th>
                  <th><button type="button" onClick={() => toggleSort("lastActivityAt")}>Last used{arrow("lastActivityAt")}</button></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const share = config.ratio && row.total ? Math.round(((row[config.ratio.part] as number) / row.total) * 100) : 0;
                  return (
                    <tr key={row.userId}>
                      <td data-label="User"><strong>{row.name}</strong><small>{row.email}{row.organizationName ? ` · ${row.organizationName}` : ""}</small></td>
                      {config.columns.map((column) => <td key={column.key} className="num" data-label={column.label}>{(row[column.key] as number ?? 0).toLocaleString()}</td>)}
                      {config.ratio && <td data-label={config.ratio.label}><div className="prod-ratio"><i><b style={{ width: `${share}%` }} /></i><span>{share}%</span></div></td>}
                      <td data-label="First added">{row.firstCreatedAt ? formatDateTime(row.firstCreatedAt) : "—"}</td>
                      <td data-label="Last used"><span className={cx("adm-badge", freshness(row.lastActivityAt))}>{relative(row.lastActivityAt)}</span><small>{row.lastActivityAt ? formatDateTime(row.lastActivityAt) : ""}</small></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && <div className="adm-pagination"><span className="adm-pagination-info">{rows.length} of {data?.users.length ?? 0} users</span></div>}
      </section>
    </div>
  );
}
