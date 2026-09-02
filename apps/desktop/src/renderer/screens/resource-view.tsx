import { useMemo, useState } from "react";
import type { AuditLog, CredentialSummary, Host, RemoteSession } from "@onshell/api-client";
import { Icon } from "../icons.js";

interface BaseProps {
  hosts: Host[];
  onClose(): void;
}

export function VaultView({ credentials, hosts, onClose }: BaseProps & { credentials: CredentialSummary[] }) {
  const hostNames = useMemo(() => new Map(hosts.map((host) => [host.id, host.name])), [hosts]);
  return (
    <section className="resource-view" aria-labelledby="vault-title">
      <header className="resource-view__head">
        <div>
          <p className="resource-view__eyebrow">Security</p>
          <h1 id="vault-title">Vault</h1>
          <p>Credential metadata is visible here; secret material never enters the renderer.</p>
        </div>
        <button className="button" onClick={onClose}>
          Back to terminals
        </button>
      </header>
      <div className="resource-view__stats">
        <div>
          <strong>{credentials.length}</strong>
          <span>Vault items</span>
        </div>
        <div>
          <strong>{credentials.filter((item) => item.kind === "ssh_key").length}</strong>
          <span>SSH keys</span>
        </div>
        <div>
          <strong>{credentials.reduce((total, item) => total + item.attachedHostIds.length, 0)}</strong>
          <span>Host assignments</span>
        </div>
      </div>
      <div className="credential-grid">
        {credentials.map((credential) => (
          <article className="credential-card" key={credential.id}>
            <span className="credential-card__icon">
              <Icon name="key" />
            </span>
            <div>
              <h2>{credential.name}</h2>
              <p>{credential.kind.replace("_", " ")}</p>
            </div>
            <div className="credential-card__hosts">
              {credential.attachedHostIds.length === 0
                ? "Not assigned"
                : credential.attachedHostIds.map((id) => hostNames.get(id) ?? "Unavailable host").join(", ")}
            </div>
            <small>{credential.lastUsedAt ? `Last used ${formatDate(credential.lastUsedAt)}` : "Not used yet"}</small>
          </article>
        ))}
        {credentials.length === 0 && (
          <Empty
            title="No vault items"
            detail="Create credentials in the web console; desktop management arrives in the infrastructure phase."
          />
        )}
      </div>
    </section>
  );
}

export function HistoryView({
  sessions,
  audit,
  hosts,
  onClose
}: BaseProps & { sessions: RemoteSession[]; audit: AuditLog[] }) {
  const [tab, setTab] = useState<"sessions" | "audit">("sessions");
  const [query, setQuery] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const hostNames = useMemo(() => new Map(hosts.map((host) => [host.id, host.name])), [hosts]);
  const pageSize = 10;
  const source = tab === "sessions" ? sessions : audit;
  const filtered = source.filter((item) => {
    const text = tab === "sessions"
      ? `${hostNames.get((item as RemoteSession).hostId) ?? ""} ${(item as RemoteSession).protocol} ${(item as RemoteSession).status}`
      : `${(item as AuditLog).action} ${(item as AuditLog).targetType} ${(item as AuditLog).targetId ?? ""}`;
    const createdAt = tab === "sessions" ? (item as RemoteSession).startedAt : (item as AuditLog).createdAt;
    return text.toLowerCase().includes(query.toLowerCase()) && (!date || createdAt.slice(0, 10) === date);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((Math.min(page, pages) - 1) * pageSize, Math.min(page, pages) * pageSize);
  return (
    <section className="resource-view" aria-labelledby="history-title">
      <header className="resource-view__head">
        <div>
          <p className="resource-view__eyebrow">Observability</p>
          <h1 id="history-title">History & audit</h1>
          <p>Recent connections and workspace security events.</p>
        </div>
        <button className="icon icon--framed resource-back" onClick={onClose} aria-label="Back to terminals" title="Back to terminals">
          <Icon name="chevron-right" size={15} />
        </button>
      </header>
      <div className="segmented" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "sessions"}
          className={tab === "sessions" ? "is-active" : ""}
          onClick={() => setTab("sessions")}
        >
          Sessions <span>{sessions.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "audit"}
          className={tab === "audit" ? "is-active" : ""}
          onClick={() => setTab("audit")}
        >
          Audit log <span>{audit.length}</span>
        </button>
      </div>
      <div className="resource-filters">
        <label><Icon name="search" size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search history" aria-label="Search history" /></label>
        <input type="date" value={date} onChange={(event) => { setDate(event.target.value); setPage(1); }} aria-label="Filter by date" />
      </div>
      {tab === "sessions" ? (
        <div className="data-table" role="table" aria-label="Recent sessions">
          <div className="data-table__row data-table__head" role="row">
            <span>Host</span>
            <span>Protocol</span>
            <span>Status</span>
            <span>Started</span>
          </div>
          {(visible as RemoteSession[]).map((session) => (
            <div className="data-table__row" role="row" key={session.id}>
              <strong>{hostNames.get(session.hostId) ?? "Unavailable host"}</strong>
              <span>{session.protocol}</span>
              <span className={`status status--${session.status}`}>{session.status}</span>
              <span>{formatDate(session.startedAt)}</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <Empty title="No sessions yet" detail="Connections opened from desktop or web will appear here." />
          )}
        </div>
      ) : (
        <div className="audit-list">
          {(visible as AuditLog[]).map((entry) => (
            <article key={entry.id}>
              <span className="audit-list__icon">
                <Icon name="history" size={15} />
              </span>
              <div>
                <strong>{entry.action.replaceAll(".", " · ")}</strong>
                <p>
                  {entry.targetType}
                  {entry.targetId ? ` · ${entry.targetId.slice(0, 8)}` : ""}
                </p>
              </div>
              <time>{formatDate(entry.createdAt)}</time>
            </article>
          ))}
          {filtered.length === 0 && (
            <Empty title="No audit events" detail="Workspace events will appear here when available." />
          )}
        </div>
      )}
      {filtered.length > 0 && <div className="resource-pagination"><button className="button button--ghost" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {Math.min(page, pages)} of {pages}</span><button className="button button--ghost" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div>}
    </section>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="resource-empty">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
