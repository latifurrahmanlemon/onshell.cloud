"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Eye,
  KeyRound,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  User as UserIcon,
  X
} from "lucide-react";
import { cx } from "@onshell/ui";
import { apiGet, apiSend, errorText, formatDateTime, useAdminResource } from "./lib";

interface AiSettings {
  provider: string;
  model: string;
  hasApiKey: boolean;
  baseUrl: string;
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  monthlyMessageCap: number;
  enabled: boolean;
  updatedAt: string | null;
}

interface AiThreadRow {
  id: string;
  title: string;
  messageCount: number;
  archivedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
  // Threads cascade-delete with their user, so this is normally present — but the
  // UI stays defensive and shows a fallback identity if a row ever lacks one.
  user: { id: string; name: string; email: string; avatarUrl: string | null } | null;
  organization: { id: string; name: string } | null;
}

interface AiThreadListResponse {
  total: number;
  take: number;
  skip: number;
  organizations: Array<{ id: string; name: string }>;
  threads: AiThreadRow[];
}

interface AiThreadDetail extends AiThreadRow {
  messages: Array<{
    id: string;
    role: "USER" | "ASSISTANT" | "SYSTEM";
    content: string;
    model: string | null;
    promptTokens: number | null;
    outputTokens: number | null;
    createdAt: string;
  }>;
}

/** Models worth offering by default; the field also accepts a free-form value. */
const MODEL_SUGGESTIONS = ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"];

const AI_FALLBACK: AiSettings = {
  provider: "openai",
  model: "gpt-4o-mini",
  hasApiKey: false,
  baseUrl: "",
  systemPrompt: "",
  temperature: 20,
  maxOutputTokens: 900,
  monthlyMessageCap: 100,
  enabled: false,
  updatedAt: null
};

/** OpenAI credentials and assistant behaviour. The stored key is never returned. */
export function AiSettingsPanel() {
  const { data, loading, error, reload } = useAdminResource<AiSettings>("/admin/ai/settings", AI_FALLBACK);

  const [form, setForm] = useState<AiSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (loading && !form) return <p className="admin-empty">Loading AI settings…</p>;
  if (!form) return <p className="admin-inline-error">{error ?? "Could not load AI settings."}</p>;

  function update<K extends keyof AiSettings>(key: K, value: AiSettings[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setFeedback(null);
  }

  async function save() {
    setBusy(true);
    setFeedback(null);
    try {
      const saved = await apiSend<AiSettings>("/admin/ai/settings", "PATCH", {
        model: form!.model.trim(),
        // Only send the key when the operator typed one, so saving other fields
        // does not wipe the stored credential.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        baseUrl: form!.baseUrl.trim() || null,
        systemPrompt: form!.systemPrompt,
        temperature: form!.temperature,
        maxOutputTokens: form!.maxOutputTokens,
        monthlyMessageCap: form!.monthlyMessageCap,
        enabled: form!.enabled
      });
      setForm(saved);
      setApiKey("");
      setFeedback({ kind: "success", text: "AI settings saved." });
    } catch (caught) {
      setFeedback({ kind: "error", text: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setTesting(true);
    setFeedback(null);
    try {
      const result = await apiSend<{ model: string; reply: string }>("/admin/ai/test", "POST", {});
      setFeedback({ kind: "success", text: `Connected to ${result.model}. Reply: "${result.reply}"` });
    } catch (caught) {
      setFeedback({ kind: "error", text: errorText(caught) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="admin-card">
      <div className="admin-card-head">
        <div>
          <h2>
            <Bot aria-hidden="true" size={17} />
            AI assistant
          </h2>
          <p>
            OpenAI credentials for the in-product assistant. The API key is encrypted with the master key and is never
            sent to the browser.
          </p>
        </div>
        <button className="admin-icon-button" type="button" aria-label="Reload" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" size={15} />
        </button>
      </div>

      <label className="admin-toggle">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => update("enabled", event.target.checked)}
        />
        <span>
          <strong>Enable the AI assistant</strong>
          <small>
            {form.hasApiKey
              ? "A key is stored. Users will see the AI Assistant view in their console."
              : "Add an API key below before enabling."}
          </small>
        </span>
      </label>

      <div className="admin-grid-2">
        <label className="admin-field">
          <span>Model</span>
          <input
            list="ai-model-options"
            value={form.model}
            onChange={(event) => update("model", event.target.value)}
            placeholder="gpt-4o-mini"
          />
          <datalist id="ai-model-options">
            {MODEL_SUGGESTIONS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <small>Any chat-completions model your key can access.</small>
        </label>

        <label className="admin-field">
          <span>
            <KeyRound aria-hidden="true" size={13} /> API key
          </span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={form.hasApiKey ? "•••••••• (stored — type to replace)" : "sk-…"}
          />
          <small>{form.hasApiKey ? "Leave blank to keep the stored key." : "Required before enabling."}</small>
        </label>

        <label className="admin-field">
          <span>Base URL (optional)</span>
          <input
            value={form.baseUrl}
            onChange={(event) => update("baseUrl", event.target.value)}
            placeholder="https://api.openai.com/v1"
          />
          <small>Override for Azure OpenAI or an OpenAI-compatible gateway.</small>
        </label>

        <label className="admin-field">
          <span>Monthly messages per user (fallback)</span>
          <input
            type="number"
            min={0}
            max={100000}
            value={form.monthlyMessageCap}
            onChange={(event) => update("monthlyMessageCap", Number(event.target.value))}
          />
          <small>Used only when the workspace&apos;s plan does not set its own AI allowance.</small>
        </label>

        <label className="admin-field">
          <span>Temperature: {(form.temperature / 100).toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={form.temperature}
            onChange={(event) => update("temperature", Number(event.target.value))}
          />
          <small>Lower is more deterministic. 0.20 suits technical answers.</small>
        </label>

        <label className="admin-field">
          <span>Max output tokens</span>
          <input
            type="number"
            min={128}
            max={8000}
            step={64}
            value={form.maxOutputTokens}
            onChange={(event) => update("maxOutputTokens", Number(event.target.value))}
          />
          <small>Caps the length — and cost — of each reply.</small>
        </label>
      </div>

      <label className="admin-field">
        <span>System prompt</span>
        <textarea
          rows={10}
          value={form.systemPrompt}
          onChange={(event) => update("systemPrompt", event.target.value)}
        />
        <small>
          Sets the assistant&apos;s scope and safety rules. Keep the instruction never to echo secrets back to the user.
        </small>
      </label>

      <div className="admin-actions">
        <button className="admin-button primary" type="button" disabled={busy} onClick={() => void save()}>
          <Save aria-hidden="true" size={15} />
          {busy ? "Saving…" : "Save AI settings"}
        </button>
        <button
          className="admin-button"
          type="button"
          disabled={testing || !form.hasApiKey}
          onClick={() => void test()}
        >
          <Sparkles aria-hidden="true" size={15} />
          {testing ? "Testing…" : "Send test prompt"}
        </button>
        {form.updatedAt && <span className="admin-meta">Last updated {formatDateTime(form.updatedAt)}</span>}
      </div>

      {feedback && (
        <p className={cx("admin-inline-feedback", feedback.kind === "error" && "is-error")} role="status">
          {feedback.kind === "error" ? <AlertCircle aria-hidden="true" size={15} /> : <CheckCircle2 aria-hidden="true" size={15} />}
          {feedback.text}
        </p>
      )}
    </div>
  );
}

/** Two initials for the avatar fallback, e.g. "Ada Lovelace" → "AL". */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

/** The person a thread belongs to, or a clear "gone" state when the row has none. */
function ThreadOwner({ user }: { user: AiThreadRow["user"] }) {
  if (!user) {
    return (
      <span className="ai-owner is-orphan">
        <span className="ai-owner-avatar is-orphan" aria-hidden="true">
          <UserIcon size={13} />
        </span>
        <span className="ai-owner-text">
          <strong>Deleted user</strong>
          <small>No account on file</small>
        </span>
      </span>
    );
  }
  return (
    <span className="ai-owner">
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="ai-owner-avatar" src={user.avatarUrl} alt="" width={26} height={26} />
      ) : (
        <span className="ai-owner-avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
      )}
      <span className="ai-owner-text">
        <strong>{user.name}</strong>
        <small>{user.email}</small>
      </span>
    </span>
  );
}

/**
 * A full conversation, shown as a chat room inside a modal.
 *
 * Opening it (the detail fetch) is written to the audit log server-side, so the
 * note in the header is a statement of fact, not a warning.
 */
function ThreadModal({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<AiThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void apiGet<AiThreadDetail>(`/admin/ai/threads/${threadId}`)
      .then((thread) => {
        if (active) setDetail(thread);
      })
      .catch((caught) => {
        if (active) setError(errorText(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [threadId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const owner = detail?.user;

  return (
    // Backdrop clicks are ignored on purpose — the Close button (or Escape) is
    // the way out, matching every other modal in the panel.
    <div className="adm-modal-backdrop">
      <div
        className="adm-modal panel adm-modal-chat"
        role="dialog"
        aria-modal="true"
        aria-label={detail?.title ?? "Conversation"}
      >
        <div className="adm-modal-head">
          <div className="adm-modal-title">
            <MessagesSquare size={18} />
            <div>
              <h2>{detail?.title ?? "Conversation"}</h2>
              {detail && (
                <p>
                  {owner ? `${owner.name} · ${owner.email}` : "Deleted user"}
                  {detail.organization ? ` · ${detail.organization.name}` : ""} · {detail.messageCount} messages ·
                  started {formatDateTime(detail.createdAt)}
                </p>
              )}
            </div>
          </div>
          <button aria-label="Close" className="admin-icon-button" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>

        <div className="adm-modal-body ai-chatroom-body">
          {loading ? (
            <p className="admin-empty">Loading conversation…</p>
          ) : error ? (
            <p className="admin-inline-error">
              <AlertCircle aria-hidden="true" size={15} />
              {error}
            </p>
          ) : detail ? (
            <>
              <p className="ai-audit-note">
                <ShieldAlert aria-hidden="true" size={13} />
                Opening this conversation was recorded in the audit log.
              </p>
              <div className="ai-chatroom">
                {detail.messages
                  .filter((message) => message.role !== "SYSTEM")
                  .map((message) => (
                    <article
                      className={cx("ai-bubble-row", `is-${message.role.toLowerCase()}`)}
                      key={message.id}
                    >
                      <div className="ai-bubble">
                        <header>
                          <strong>{message.role === "USER" ? owner?.name ?? "User" : "Assistant"}</strong>
                          <span>
                            {formatDateTime(message.createdAt)}
                            {message.model ? ` · ${message.model}` : ""}
                            {message.outputTokens ? ` · ${message.outputTokens} tok` : ""}
                          </span>
                        </header>
                        <pre>{message.content}</pre>
                      </div>
                    </article>
                  ))}
                {detail.messages.filter((message) => message.role !== "SYSTEM").length === 0 && (
                  <p className="admin-empty">This conversation has no messages.</p>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Every AI conversation on the platform, in a table for support and abuse
 * review. Each row can be opened (a chat-room modal, logged) or deleted (logged
 * and irreversible).
 */
export function AiThreadsSection() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [archived, setArchived] = useState("all");
  const [messages, setMessages] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("lastMessageAt-desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [viewId, setViewId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => setPage(1), [debouncedSearch, organizationId, archived, messages, from, to, sort, pageSize]);

  const query = useMemo(() => {
    const [sortKey, direction] = sort.split("-");
    const params = new URLSearchParams({
      take: String(pageSize),
      skip: String((page - 1) * pageSize),
      archived,
      messages,
      sort: sortKey!,
      direction: direction!
    });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (organizationId) params.set("organizationId", organizationId);
    if (from) params.set("from", `${from}T00:00:00.000Z`);
    if (to) params.set("to", `${to}T23:59:59.999Z`);
    return params.toString();
  }, [archived, debouncedSearch, from, messages, organizationId, page, pageSize, sort, to]);

  const { data, loading, error, reload } = useAdminResource<AiThreadListResponse>(`/admin/ai/threads?${query}`);
  const threads = data?.threads ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const filtersActive = Boolean(debouncedSearch || organizationId || archived !== "all" || messages !== "all" || from || to);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function clearFilters() {
    setSearch("");
    setOrganizationId("");
    setArchived("all");
    setMessages("all");
    setFrom("");
    setTo("");
  }

  async function remove(thread: AiThreadRow) {
    const owner = thread.user ? thread.user.name : "a deleted user";
    if (
      !window.confirm(
        `Delete "${thread.title}" (${owner})? This permanently removes the conversation and all ${thread.messageCount} messages. This cannot be undone.`
      )
    ) {
      return;
    }

    setDeletingId(thread.id);
    setFeedback(null);
    try {
      await apiSend(`/admin/ai/threads/${thread.id}`, "DELETE");
      if (viewId === thread.id) setViewId(null);
      setFeedback({ kind: "success", text: `Deleted "${thread.title}".` });
      await reload();
    } catch (caught) {
      setFeedback({ kind: "error", text: errorText(caught) });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="admin-card">
      <div className="admin-card-head">
        <div>
          <h2>
            <Bot aria-hidden="true" size={17} />
            AI conversations
          </h2>
          <p>{data ? `${data.total} conversations across all workspaces` : "Loading…"}</p>
        </div>
        <button className="admin-icon-button" type="button" aria-label="Reload" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" size={15} className={loading ? "is-spinning" : undefined} />
        </button>
      </div>

      <div className="adm-ai-toolbar">
        <label className="inbox-search">
          <Search aria-hidden="true" size={15} />
          <input placeholder="Search title, user, email, or workspace" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search conversations" />
        </label>
        <select aria-label="Filter conversations by workspace" className="adm-filter" onChange={(event) => setOrganizationId(event.target.value)} value={organizationId}>
          <option value="">All workspaces</option>
          {(data?.organizations ?? []).map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
        </select>
        <select aria-label="Filter conversations by archive status" className="adm-filter" onChange={(event) => setArchived(event.target.value)} value={archived}>
          <option value="all">All statuses</option><option value="open">Open</option><option value="archived">Archived</option>
        </select>
        <select aria-label="Filter conversations by messages" className="adm-filter" onChange={(event) => setMessages(event.target.value)} value={messages}>
          <option value="all">Any message count</option><option value="with">With messages</option><option value="empty">Empty</option>
        </select>
        <label className="logs-date-field"><span>From</span><input aria-label="Conversation activity from" onChange={(event) => setFrom(event.target.value)} type="date" value={from} /></label>
        <label className="logs-date-field"><span>To</span><input aria-label="Conversation activity to" onChange={(event) => setTo(event.target.value)} type="date" value={to} /></label>
        <select aria-label="Sort conversations" className="adm-filter" onChange={(event) => setSort(event.target.value)} value={sort}>
          <option value="lastMessageAt-desc">Recent activity</option><option value="lastMessageAt-asc">Oldest activity</option><option value="createdAt-desc">Newest created</option><option value="messageCount-desc">Most messages</option><option value="title-asc">Title A–Z</option>
        </select>
        {filtersActive && <button className="adm-link-button" onClick={clearFilters} type="button">Clear filters</button>}
      </div>

      {error && (
        <p className="admin-inline-error" role="alert">
          <AlertCircle aria-hidden="true" size={15} />
          {error}
        </p>
      )}

      {feedback && (
        <p className={cx("admin-inline-feedback", feedback.kind === "error" && "is-error")} role="status">
          {feedback.kind === "error" ? (
            <AlertCircle aria-hidden="true" size={15} />
          ) : (
            <CheckCircle2 aria-hidden="true" size={15} />
          )}
          {feedback.text}
        </p>
      )}

      {!loading && threads.length === 0 ? (
        <p className="admin-empty">{filtersActive ? "No conversations match the current search and filters." : "No AI conversations yet."}</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table ai-threads-table">
            <caption className="sr-only">AI conversations across all workspaces</caption>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Workspace</th>
                <th scope="col">Conversation</th>
                <th scope="col">Messages</th>
                <th scope="col">Last activity</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {threads.map((thread) => (
                <tr key={thread.id}>
                  <th scope="row" data-label="User">
                    <ThreadOwner user={thread.user} />
                  </th>
                  <td data-label="Workspace">{thread.organization?.name ?? "—"}</td>
                  <td data-label="Conversation">
                    <span className="ai-thread-title">{thread.title}<small>{thread.archivedAt ? "Archived" : "Open"}</small></span>
                  </td>
                  <td className="ai-threads-num" data-label="Messages">{thread.messageCount}</td>
                  <td className="ai-threads-date" data-label="Last activity">{formatDateTime(thread.lastMessageAt)}</td>
                  <td data-label="Actions">
                    <div className="ai-threads-actions">
                      <button
                        className="icon-button compact"
                        type="button"
                        onClick={() => setViewId(thread.id)}
                        aria-label={`View conversation "${thread.title}"`}
                        title="View conversation"
                      >
                        <Eye aria-hidden="true" size={14} />
                      </button>
                      <button
                        className="icon-button compact danger"
                        type="button"
                        disabled={deletingId === thread.id}
                        onClick={() => void remove(thread)}
                        aria-label={`Delete conversation "${thread.title}"`}
                        title={deletingId === thread.id ? "Deleting…" : "Delete conversation"}
                      >
                        {deletingId === thread.id ? <Loader2 aria-hidden="true" className="is-spinning" size={14} /> : <Trash2 aria-hidden="true" size={14} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && <div className="adm-pagination">
        <label className="adm-page-size">Rows per page<select aria-label="AI conversations rows per page" onChange={(event) => setPageSize(Number(event.target.value))} value={pageSize}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <span className="adm-pagination-info">Page {page} of {totalPages} · {data.total.toLocaleString()} conversations</span>
        <div className="adm-pagination-controls"><button aria-label="Previous conversations page" className="icon-button compact" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button"><ChevronLeft size={15} /></button><button aria-label="Next conversations page" className="icon-button compact" disabled={page >= totalPages || loading} onClick={() => setPage((current) => current + 1)} type="button"><ChevronRight size={15} /></button></div>
      </div>}

      {viewId && <ThreadModal threadId={viewId} onClose={() => setViewId(null)} />}
    </div>
  );
}
