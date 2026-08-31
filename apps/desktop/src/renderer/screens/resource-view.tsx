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
  const hostNames = useMemo(() => new Map(hosts.map((host) => [host.id, host.name])), [hosts]);
  return (
    <section className="resource-view" aria-labelledby="history-title">
      <header className="resource-view__head">
        <div>
          <p className="resource-view__eyebrow">Observability</p>
          <h1 id="history-title">History & audit</h1>
          <p>Recent connections and workspace security events.</p>
        </div>
        <button className="button" onClick={onClose}>
          Back to terminals
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
      {tab === "sessions" ? (
        <div className="data-table" role="table" aria-label="Recent sessions">
          <div className="data-table__row data-table__head" role="row">
            <span>Host</span>
            <span>Protocol</span>
            <span>Status</span>
            <span>Started</span>
          </div>
          {sessions.map((session) => (
            <div className="data-table__row" role="row" key={session.id}>
              <strong>{hostNames.get(session.hostId) ?? "Unavailable host"}</strong>
              <span>{session.protocol}</span>
              <span className={`status status--${session.status}`}>{session.status}</span>
              <span>{formatDate(session.startedAt)}</span>
            </div>
          ))}
          {sessions.length === 0 && (
            <Empty title="No sessions yet" detail="Connections opened from desktop or web will appear here." />
          )}
        </div>
      ) : (
        <div className="audit-list">
          {audit.map((entry) => (
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
          {audit.length === 0 && (
            <Empty title="No audit events" detail="Workspace events will appear here when available." />
          )}
        </div>
      )}
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
