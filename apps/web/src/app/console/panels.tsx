"use client";

import {
  ChangeEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Braces,
  Camera,
  Check,
  Circle,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  MonitorUp,
  Palette,
  Play,
  Plus,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type {
  AuditLog,
  CredentialSummary,
  Host,
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
import type { PendingInvitation, TeamMember } from "./api";
import { consoleApi } from "./api";
import type { ThemeMode } from "../theme";

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

/* ---------- Hosts ---------- */

const protocolIcons = {
  ssh: SquareTerminal,
  rdp: MonitorUp,
  vnc: MonitorUp,
} as const;

export function HostsView({
  hosts,
  role,
  loading,
  error,
  onLaunch,
  onDelete,
  onRefresh,
  onCreated,
  notify,
}: {
  hosts: Host[];
  role: Role;
  loading: boolean;
  error: string | null;
  onLaunch: (host: Host, protocol: "ssh" | "sftp" | "rdp") => void;
  onDelete: (host: Host) => void;
  onRefresh: () => void;
  onCreated: () => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "ssh" | "rdp" | "vnc">(
    "all",
  );
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await consoleApi.createHost({
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
      });
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
            <button
              className="primary-button"
              onClick={() => setAdding(true)}
              type="button"
            >
              <Plus size={15} />
              Add Host
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
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
        <div className="host-table">
          <div className="host-row table-head">
            <span>Name</span>
            <span>Address</span>
            <span>Environment</span>
            <span>Health</span>
            <span />
          </div>
          {filtered.map((host) => {
            const Icon = protocolIcons[host.type] ?? SquareTerminal;
            return (
              <div className="host-row" key={host.id}>
                <div className="host-title">
                  <Icon className={cx("protocol-icon", host.type)} size={16} />
                  <div>
                    <strong>{host.name}</strong>
                    <small>
                      {host.type.toUpperCase()}
                      {host.group ? ` · ${host.group}` : ""}
                      {host.tags.length > 0 ? ` · ${host.tags.join(", ")}` : ""}
                    </small>
                  </div>
                </div>
                <span>
                  {host.address}:{host.port}
                </span>
                <span className={cx("env-pill", host.environment)}>
                  {host.environment}
                </span>
                <span className={cx("health-badge", host.health)}>
                  {host.health}
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
                  {canManageHosts(role) && (
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
          <div className="form-actions span-two">
            <SubmitButton busy={busy} label="Add Host" />
          </div>
        </form>
      </Drawer>
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
  const [busy, setBusy] = useState(false);
  const hostName = (id: string) =>
    hosts.find((host) => host.id === id)?.name ?? "unknown";

  async function submit(event: FormEvent<HTMLFormElement>) {
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

  async function remove(credential: CredentialSummary) {
    if (
      !window.confirm(
        `Delete credential "${credential.name}"? Hosts using it will need a new one.`,
      )
    )
      return;
    try {
      await consoleApi.deleteCredential(credential.id);
      notify("Credential deleted.", "success");
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not delete credential.",
        "error",
      );
    }
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
        {canManageHosts(role) && (
          <button
            className="primary-button"
            onClick={() => setAdding(true)}
            type="button"
          >
            <Plus size={15} />
            Add Credential
          </button>
        )}
      </div>

      {loading ? (
        <>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </>
      ) : credentials.length === 0 ? (
        <EmptyState
          hint="Store a password or SSH key so sessions can connect without exposing secrets."
          icon={<KeyRound size={22} />}
          title="Vault is empty"
        />
      ) : (
        <div className="host-table">
          {credentials.map((credential) => (
            <div
              className="host-row"
              key={credential.id}
              style={{ cursor: "default" }}
            >
              <div className="host-title">
                <KeyRound className="protocol-icon" size={16} />
                <div>
                  <strong>{credential.name}</strong>
                  <small>
                    {credential.kind.replace("_", " ")}
                    {credential.rotatedAt
                      ? ` · rotated ${new Date(credential.rotatedAt).toLocaleDateString()}`
                      : ""}
                  </small>
                </div>
              </div>
              <span>
                {credential.attachedHostIds.length > 0
                  ? credential.attachedHostIds.map(hostName).join(", ")
                  : "Not attached"}
              </span>
              <span />
              <span />
              <div className="row-actions">
                {canManageHosts(role) && (
                  <button
                    aria-label={`Delete ${credential.name}`}
                    className="icon-button compact"
                    onClick={() => remove(credential)}
                    title="Delete credential"
                    type="button"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Drawer
        onClose={() => setAdding(false)}
        open={adding}
        subtitle="The secret is encrypted with AES-256-GCM before it is stored."
        title="Add credential"
      >
        <form className="form-grid" onSubmit={submit}>
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
    </section>
  );
}

/* ---------- Snippets ---------- */

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
        <button
          className="primary-button"
          onClick={() => setAdding(true)}
          type="button"
        >
          <Plus size={15} />
          New Snippet
        </button>
      </div>

      {loading ? (
        <>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </>
      ) : snippets.length === 0 ? (
        <EmptyState
          hint="Save the commands you run on every server."
          icon={<Braces size={22} />}
          title="No snippets yet"
        />
      ) : (
        <div className="snippet-list">
          {snippets.map((snippet) => (
            <div
              className="snippet-row"
              key={snippet.id}
              style={{ cursor: "default" }}
            >
              <Braces size={15} />
              <div style={{ minWidth: 0 }}>
                <strong>{snippet.name}</strong>
                <small style={{ fontFamily: "var(--font-mono), monospace" }}>
                  {snippet.command}
                </small>
              </div>
              <div className="row-actions">
                <button
                  aria-label={`Copy ${snippet.name}`}
                  className="icon-button compact"
                  onClick={() => copy(snippet)}
                  title="Copy"
                  type="button"
                >
                  <ScrollText size={14} />
                </button>
                <button
                  aria-label={`Run ${snippet.name}`}
                  className="icon-button compact"
                  disabled={!hasActiveTerminal}
                  onClick={() => onRun(snippet.command)}
                  title={
                    hasActiveTerminal
                      ? "Run in active terminal"
                      : "Open a terminal first"
                  }
                  type="button"
                >
                  <Play size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

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

/* ---------- Team ---------- */

export function TeamView({
  members,
  invitations,
  currentUser,
  loading,
  onChanged,
  notify,
}: {
  members: TeamMember[];
  invitations: PendingInvitation[];
  currentUser: User;
  loading: boolean;
  onChanged: () => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const [busy, setBusy] = useState(false);
  const manager = canManageUsers(currentUser.role);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await consoleApi.invite({
        email: String(data.get("email") ?? ""),
        role: String(data.get("role") ?? "developer") as Role,
      });
      notify("Invitation sent by email.", "success");
      form.reset();
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

  async function remove(member: TeamMember) {
    if (!window.confirm(`Remove ${member.name} from the organization?`)) return;
    try {
      await consoleApi.removeMember(member.id);
      notify("Member removed.", "success");
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not remove member.",
        "error",
      );
    }
  }

  async function revoke(invitation: PendingInvitation) {
    try {
      await consoleApi.revokeInvitation(invitation.id);
      notify("Invitation revoked.", "success");
      onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not revoke invitation.",
        "error",
      );
    }
  }

  return (
    <div className="main-column">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Team Members</h2>
            <p>Roles control what each member can see and open.</p>
          </div>
        </div>
        {loading ? (
          <>
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </>
        ) : (
          members.map((member) => (
            <div className="member-row" key={member.id}>
              <div>
                <strong>
                  {member.name}
                  {member.id === currentUser.id ? " (you)" : ""}
                </strong>
                <small>{member.email}</small>
              </div>
              <span
                className={cx(
                  "env-pill",
                  member.twoFactorEnabled && "development",
                )}
              >
                {member.twoFactorEnabled ? "2FA on" : "2FA off"}
              </span>
              {manager && member.id !== currentUser.id ? (
                <select
                  aria-label={`Role for ${member.name}`}
                  onChange={(event) =>
                    changeRole(member, event.target.value as Role)
                  }
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
              )}
              {manager && member.id !== currentUser.id ? (
                <button
                  aria-label={`Remove ${member.name}`}
                  className="danger-button"
                  onClick={() => remove(member)}
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              ) : (
                <span />
              )}
            </div>
          ))
        )}
      </section>

      {manager && (
        <section className="panel">
          <div className="panel-header tight">
            <div>
              <h2>Invite Member</h2>
              <p>They will receive an email link to join this workspace.</p>
            </div>
          </div>
          <div className="settings-block">
            <form className="inline-form" onSubmit={invite}>
              <input
                aria-label="Email address"
                name="email"
                placeholder="teammate@company.com"
                required
                style={{ flex: "1 1 220px" }}
                type="email"
              />
              <select aria-label="Role" defaultValue="developer" name="role">
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <button className="primary-button" disabled={busy} type="submit">
                {busy ? (
                  <Loader2 className="spin" size={15} />
                ) : (
                  <Mail size={15} />
                )}
                Send Invite
              </button>
            </form>
          </div>
          {invitations.length > 0 && (
            <div className="host-table">
              {invitations.map((invitation) => (
                <div className="member-row" key={invitation.id}>
                  <div>
                    <strong>{invitation.email}</strong>
                    <small>
                      pending · {invitation.role}
                      {invitation.expiresAt
                        ? ` · expires ${new Date(invitation.expiresAt).toLocaleDateString()}`
                        : ""}
                    </small>
                  </div>
                  <span />
                  <span />
                  <button
                    className="danger-button"
                    onClick={() => revoke(invitation)}
                    type="button"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/* ---------- Audit ---------- */

export function AuditView({
  logs,
  loading,
  memberNames,
}: {
  logs: AuditLog[];
  loading: boolean;
  memberNames: Map<string, string>;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Audit Log</h2>
          <p>
            Every session, credential, and admin action in this organization.
          </p>
        </div>
      </div>
      {loading ? (
        <>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </>
      ) : logs.length === 0 ? (
        <EmptyState
          hint="Activity will appear here as your team works."
          icon={<ScrollText size={22} />}
          title="No audit events yet"
        />
      ) : (
        <div className="audit-list">
          {logs.map((log) => (
            <div className="audit-row" key={log.id}>
              <span>
                {new Date(log.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <div>
                <strong>{log.action.replaceAll(".", " · ")}</strong>
                <small>
                  {memberNames.get(log.actorId) ?? "system"} · {log.targetType}
                  {log.targetId ? ` · ${log.targetId.slice(0, 8)}` : ""} ·{" "}
                  {new Date(log.createdAt).toLocaleDateString()}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- Settings ---------- */

const modeSwatches: Record<ThemeMode, string[]> = {
  dark: ["#111312", "#1c271c", "#65c466"],
  light: ["#f4f7f1", "#e2efe0", "#1e7d3c"],
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
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "security", label: "Two-Factor", icon: ShieldCheck },
  { key: "password", label: "Password", icon: KeyRound },
  { key: "session", label: "Session", icon: LogOut },
] as const;

type SettingsTab = (typeof settingsTabs)[number]["key"];

export function SettingsView({
  user,
  organizationName,
  mode,
  onMode,
  onLogout,
  onProfileUpdated,
  notify,
}: {
  user: User;
  organizationName: string;
  mode: ThemeMode;
  onMode: (mode: ThemeMode) => void;
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

        {tab === "appearance" && (
          <section className="panel">
            <div className="panel-header tight">
              <div>
                <h2>Appearance</h2>
                <p>Workspace theme, saved on this device.</p>
              </div>
            </div>
            <div className="theme-options">
              {(Object.keys(modeSwatches) as ThemeMode[]).map((name) => (
                <button
                  className={cx("theme-option", mode === name && "is-active")}
                  key={name}
                  onClick={() => onMode(name)}
                  type="button"
                >
                  <span
                    className="theme-swatch"
                    style={{ background: modeSwatches[name][0] }}
                  >
                    {modeSwatches[name].map((color) => (
                      <i key={color} style={{ background: color }} />
                    ))}
                  </span>
                  {name === "dark" ? "Dark" : "Light"}
                </button>
              ))}
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
