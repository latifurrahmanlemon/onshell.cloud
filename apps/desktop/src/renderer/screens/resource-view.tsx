import { useEffect, useMemo, useState } from "react";
import type { AuditLog, CredentialSummary, Host, RemoteSession } from "@onshell/api-client";
import { Icon } from "../icons.js";
import { bridge } from "../bridge.js";

interface BaseProps {
  hosts: Host[];
  onClose(): void;
}

type ViewMode = "grid" | "list";

function ViewToggle({ value, onChange }: { value: ViewMode; onChange(value: ViewMode): void }) {
  return <div className="resource-view-toggle" role="group" aria-label="Layout">
    <button className={value === "grid" ? "is-active" : ""} onClick={() => onChange("grid")} aria-pressed={value === "grid"} title="Grid view"><Icon name="grid" size={14}/><span>Grid</span></button>
    <button className={value === "list" ? "is-active" : ""} onClick={() => onChange("list")} aria-pressed={value === "list"} title="List view"><Icon name="list" size={14}/><span>List</span></button>
  </div>;
}

export function HostsView({ hosts, onClose, onOpen, onEdit }: BaseProps & { onOpen(host: Host): void; onEdit(host: Host | "new"): void }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("grid");
  const visible = hosts.filter((host) => `${host.name} ${host.address} ${host.username ?? ""} ${host.environment} ${host.tags.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="resource-view" aria-labelledby="hosts-title">
    <header className="resource-view__head"><div><p className="resource-view__eyebrow">Infrastructure</p><h1 id="hosts-title">Hosts</h1><p>Browse every saved machine in a compact grid or detailed list.</p></div><button className="icon icon--framed resource-back" onClick={onClose} aria-label="Back to terminals" title="Back to terminals"><Icon name="chevron-right" size={15}/></button></header>
    <div className="resource-filters"><label><Icon name="search" size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search hosts"/></label><ViewToggle value={view} onChange={setView}/><button className="button button--primary" onClick={() => onEdit("new")}><Icon name="plus" size={14}/>Add host</button></div>
    <div className={`host-resource host-resource--${view}`}>
      {visible.map((host) => <article className="host-resource-card" key={host.id}><span className="credential-card__icon"><Icon name={host.isLocal ? "computer" : "host"}/></span><div className="host-resource-card__identity"><h2>{host.name}</h2><p className="selectable">{host.username ? `${host.username}@` : ""}{host.address}{host.port !== 22 ? `:${host.port}` : ""}</p></div><span className="host-resource-card__environment">{host.environment}</span><div className="host-resource-card__actions"><button className="icon icon--framed" onClick={() => onOpen(host)} title="Connect" aria-label={`Connect to ${host.name}`}><Icon name="play" size={13}/></button>{!host.isLocal && !host.isAgent && <button className="icon icon--framed" onClick={() => onEdit(host)} title="Edit" aria-label={`Edit ${host.name}`}><Icon name="gear" size={13}/></button>}</div></article>)}
      {visible.length === 0 && (
        <Empty title="No hosts found" detail={hosts.length ? "Try another search." : "Add your first host to connect."}/>
      )}
    </div>
  </section>;
}

export function VaultView({ credentials, hosts, onClose, openCreateOnMount = false }: BaseProps & { credentials: CredentialSummary[]; openCreateOnMount?: boolean }) {
  const [items, setItems] = useState(credentials);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "used">("name");
  const [view, setView] = useState<ViewMode>("grid");
  const [creating, setCreating] = useState(openCreateOnMount);
  const [editing, setEditing] = useState<CredentialSummary>();
  const [error, setError] = useState<string>();
  useEffect(() => setItems(credentials), [credentials]);
  const hostNames = useMemo(() => new Map(hosts.map((host) => [host.id, host.name])), [hosts]);
  const visible = items.filter((item) => `${item.name} ${item.kind} ${item.attachedHostIds.map((id) => hostNames.get(id) ?? "").join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    try { const item = await bridge.console.createCredential({ name: String(data.get("name") ?? ""), kind: data.get("kind") as "password" | "ssh_key" | "rdp_password", secret: String(data.get("secret") ?? ""), attachedHostIds: data.getAll("hosts").map(String) }); setItems((current) => [item, ...current]); setCreating(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create credential."); }
  }
  async function remove(item: CredentialSummary) {
    if (item.attachedHostIds.length > 0) return;
    try { await bridge.console.deleteCredential(item.id); setItems((current) => current.filter((entry) => entry.id !== item.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete credential."); }
  }
  async function update(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const data = new FormData(event.currentTarget);
    try {
      let item = await bridge.console.updateCredential(editing.id, { name: String(data.get("name") ?? ""), attachedHostIds: data.getAll("hosts").map(String) });
      const secret = String(data.get("secret") ?? "").trim();
      if (secret) item = await bridge.console.rotateCredential(editing.id, secret);
      setItems((current) => current.map((entry) => entry.id === item.id ? item : entry));
      setEditing(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update credential."); }
  }
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
      <div className="resource-filters"><label><Icon name="search" size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search vault"/></label><select value={sort} onChange={(event) => setSort(event.target.value as "name" | "used")}><option value="name">Name</option><option value="used">Last used</option></select><ViewToggle value={view} onChange={setView}/><button className="button button--primary" onClick={() => setCreating(true)}><Icon name="plus" size={14}/>Add</button></div>
      {error && <p className="error">{error}</p>}
      <div className="resource-view__stats">
        <div>
          <strong>{items.length}</strong>
          <span>Vault items</span>
        </div>
        <div>
          <strong>{items.filter((item) => item.kind === "ssh_key").length}</strong>
          <span>SSH keys</span>
        </div>
        <div>
          <strong>{items.reduce((total, item) => total + item.attachedHostIds.length, 0)}</strong>
          <span>Host assignments</span>
        </div>
      </div>
      <div className={`credential-grid credential-grid--${view}`}>
        {visible.map((credential) => (
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
            <div className="credential-card__actions"><button className="icon icon--framed" aria-label={`Edit ${credential.name}`} title="Edit credential" onClick={() => setEditing(credential)}><Icon name="gear" size={13}/></button><button className="icon icon--danger" aria-label={`Delete ${credential.name}`} disabled={credential.attachedHostIds.length > 0} onClick={() => void remove(credential)} title={credential.attachedHostIds.length > 0 ? "Detach from hosts before deleting" : "Delete credential"}><Icon name="close" size={13}/></button></div>
          </article>
        ))}
        {visible.length === 0 && (
          <Empty
            title="No vault items"
            detail="Add a password or SSH key and assign it to one or more hosts."
          />
        )}
      </div>
      {creating && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false); }}><form className="snippet-modal vault-modal" onSubmit={(event) => void create(event)}><header><div><span className="snippet-emoji"><Icon name="key" size={16}/></span><div><strong>Add credential</strong><p>Secret material is encrypted before storage.</p></div></div><button className="icon" type="button" onClick={() => setCreating(false)} aria-label="Close"><Icon name="close" size={13}/></button></header><label>Name<input name="name" required minLength={2}/></label><label>Type<select name="kind"><option value="password">Password</option><option value="ssh_key">SSH key</option><option value="rdp_password">RDP password</option></select></label><label>Secret<textarea name="secret" required rows={5}/></label><HostChoices hosts={hosts} selected={[]}/><footer><button className="button button--ghost" type="button" onClick={() => setCreating(false)}>Cancel</button><button className="button button--primary" type="submit">Save credential</button></footer></form></div>}
      {editing && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(undefined); }}><form className="snippet-modal vault-modal" onSubmit={(event) => void update(event)}><header><div><span className="snippet-emoji"><Icon name="key" size={16}/></span><div><strong>Edit credential</strong><p>Leave the replacement secret blank to keep the current one.</p></div></div><button className="icon" type="button" onClick={() => setEditing(undefined)} aria-label="Close"><Icon name="close" size={13}/></button></header><label>Name<input name="name" required minLength={2} defaultValue={editing.name}/></label><label>Replace secret<textarea name="secret" rows={5} placeholder="Keep current secret"/></label><HostChoices hosts={hosts} selected={editing.attachedHostIds}/><footer><button className="button button--ghost" type="button" onClick={() => setEditing(undefined)}>Cancel</button><button className="button button--primary" type="submit">Save changes</button></footer></form></div>}
    </section>
  );
}

function HostChoices({ hosts, selected }: { hosts: Host[]; selected: string[] }) {
  const [query, setQuery] = useState("");
  const available = hosts.filter((host) => !host.isLocal && `${host.name} ${host.address}`.toLowerCase().includes(query.toLowerCase()));
  return <fieldset className="vault-hosts"><legend>Attach to hosts</legend><label className="vault-hosts__search"><Icon name="search" size={13}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a host" aria-label="Find a host"/></label><div className="vault-hosts__list">{available.map((host) => <label key={host.id}><input type="checkbox" name="hosts" value={host.id} defaultChecked={selected.includes(host.id)}/><span><strong>{host.name}</strong><small>{host.address} · {host.environment}</small></span></label>)}{available.length === 0 && <p>No matching hosts.</p>}</div></fieldset>;
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
