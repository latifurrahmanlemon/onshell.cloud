"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Bot, CheckCircle2, KeyRound, RefreshCw, Save, Search, Sparkles, User as UserIcon } from "lucide-react";
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
  lastMessageAt: string;
  createdAt: string;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
  organization: { id: string; name: string };
}

interface AiThreadListResponse {
  total: number;
  take: number;
  skip: number;
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

/**
 * Every AI conversation on the platform, for support and abuse review.
 *
 * Opening a thread is itself written to the audit log — reading a user's
 * conversation is a privileged action and should leave a trace.
 */
export function AiThreadsSection() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiThreadDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ take: "100" });
    if (debouncedSearch) params.set("search", debouncedSearch);
    return params.toString();
  }, [debouncedSearch]);

  const { data, loading, error, reload } = useAdminResource<AiThreadListResponse>(`/admin/ai/threads?${query}`);
  const threads = data?.threads ?? [];

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }

    let active = true;
    setLoadingDetail(true);
    setDetailError(null);

    void apiGet<AiThreadDetail>(`/admin/ai/threads/${selectedId}`)
      .then((thread) => {
        if (active) setDetail(thread);
      })
      .catch((caught) => {
        if (active) setDetailError(errorText(caught));
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });

    return () => {
      active = false;
    };
  }, [selectedId]);

  return (
    <div className="inbox-layout">
      <div className="admin-card inbox-list-card">
        <div className="admin-card-head">
          <div>
            <h2>
              <Bot aria-hidden="true" size={17} />
              AI conversations
            </h2>
            <p>{data ? `${data.total} threads across all workspaces` : "Loading…"}</p>
          </div>
          <button className="admin-icon-button" type="button" aria-label="Reload" onClick={() => void reload()}>
            <RefreshCw aria-hidden="true" size={15} className={loading ? "is-spinning" : undefined} />
          </button>
        </div>

        <label className="inbox-search">
          <Search aria-hidden="true" size={15} />
          <input
            placeholder="Search by title, user name, or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search conversations"
          />
        </label>

        {error && (
          <p className="admin-inline-error" role="alert">
            <AlertCircle aria-hidden="true" size={15} />
            {error}
          </p>
        )}

        <div className="inbox-list" role="list">
          {!loading && threads.length === 0 && <p className="admin-empty">No AI conversations yet.</p>}
          {threads.map((thread) => (
            <button
              className={cx("inbox-item", thread.id === selectedId && "is-active")}
              key={thread.id}
              type="button"
              role="listitem"
              onClick={() => setSelectedId(thread.id)}
            >
              <span className="inbox-item-top">
                <span className="inbox-item-name">{thread.title}</span>
              </span>
              <span className="inbox-item-subject">
                <UserIcon aria-hidden="true" size={12} /> {thread.user.name} · {thread.organization.name}
              </span>
              <span className="inbox-item-date">
                {thread.messageCount} messages · {formatDateTime(thread.lastMessageAt)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="admin-card inbox-detail-card">
        {!selectedId ? (
          <p className="admin-empty">Select a conversation to review it.</p>
        ) : loadingDetail ? (
          <p className="admin-empty">Loading conversation…</p>
        ) : detailError ? (
          <p className="admin-inline-error">{detailError}</p>
        ) : detail ? (
          <>
            <div className="admin-card-head">
              <div>
                <h2>{detail.title}</h2>
                <p>
                  {detail.user.name} ({detail.user.email}) · {detail.organization.name}
                </p>
              </div>
            </div>
            <p className="admin-meta">
              Opening this conversation has been recorded in the audit log.
            </p>
            <div className="ai-review">
              {detail.messages.map((message) => (
                <article className={cx("ai-review-message", `is-${message.role.toLowerCase()}`)} key={message.id}>
                  <header>
                    <strong>{message.role === "USER" ? detail.user.name : "Assistant"}</strong>
                    <span>
                      {formatDateTime(message.createdAt)}
                      {message.model ? ` · ${message.model}` : ""}
                      {message.outputTokens ? ` · ${message.outputTokens} out` : ""}
                    </span>
                  </header>
                  <pre>{message.content}</pre>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
