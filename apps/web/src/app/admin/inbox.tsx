"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Inbox,
  Mail,
  RefreshCw,
  Save,
  Search,
  ShieldOff,
  Trash2
} from "lucide-react";
import { cx } from "@onshell/ui";
import { apiSend, errorText, formatDateTime, useAdminResource } from "./lib";

type ContactStatus = "NEW" | "OPEN" | "RESOLVED" | "SPAM";

interface ContactMessage {
  id: string;
  name: string;
  email: string;
  company: string | null;
  topic: string;
  message: string;
  status: ContactStatus;
  adminNotes: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  submittedById: string | null;
  handledAt: string | null;
  createdAt: string;
  handledBy?: { id: string; name: string; email: string } | null;
}

interface ContactListResponse {
  total: number;
  unread: number;
  take: number;
  skip: number;
  messages: ContactMessage[];
}

const STATUS_FILTERS: Array<{ value: ContactStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "NEW", label: "New" },
  { value: "OPEN", label: "In progress" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "SPAM", label: "Spam" }
];

const STATUS_LABELS: Record<ContactStatus, string> = {
  NEW: "New",
  OPEN: "In progress",
  RESOLVED: "Resolved",
  SPAM: "Spam"
};

const TOPIC_LABELS: Record<string, string> = {
  general: "General",
  sales: "Pricing & plans",
  support: "Support",
  security: "Security",
  partnership: "Partnership"
};

/**
 * Contact-form inbox.
 *
 * A list on the left, the selected message on the right, with status and internal
 * notes editable in place. Notes are admin-only and never returned to the sender.
 */
export function InboxSection({ onUnreadChange }: { onUnreadChange?: (count: number) => void }) {
  const [statusFilter, setStatusFilter] = useState<ContactStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // Debounce so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (debouncedSearch) params.set("search", debouncedSearch);
    params.set("take", "100");
    return params.toString();
  }, [statusFilter, debouncedSearch]);

  const { data, loading, error, reload, setData } = useAdminResource<ContactListResponse>(
    `/admin/contact-messages?${query}`
  );

  const messages = data?.messages ?? [];
  const selected = messages.find((message) => message.id === selectedId) ?? null;

  useEffect(() => {
    if (data?.unread !== undefined) onUnreadChange?.(data.unread);
    // onUnreadChange is typically an inline arrow; excluding it avoids a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.unread]);

  // Keep the notes field in sync with whichever message is open.
  useEffect(() => {
    setNotes(selected?.adminNotes ?? "");
    setFeedback(null);
  }, [selected?.id, selected?.adminNotes]);

  // Auto-select the first message once the list resolves.
  useEffect(() => {
    if (!selectedId && messages.length > 0) setSelectedId(messages[0].id);
  }, [messages, selectedId]);

  async function update(messageId: string, body: { status?: ContactStatus; adminNotes?: string | null }) {
    setBusy(true);
    setFeedback(null);
    try {
      const updated = await apiSend<ContactMessage>(`/admin/contact-messages/${messageId}`, "PATCH", body);
      setData((current) =>
        current
          ? {
              ...current,
              // Recompute the NEW count locally so the sidebar badge is right
              // without a second round-trip.
              unread: current.messages.reduce(
                (count, message) =>
                  count + ((message.id === messageId ? updated.status : message.status) === "NEW" ? 1 : 0),
                0
              ),
              messages: current.messages.map((message) => (message.id === messageId ? updated : message))
            }
          : current
      );
      setFeedback({ kind: "success", text: "Saved." });
    } catch (caught) {
      setFeedback({ kind: "error", text: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(messageId: string) {
    setBusy(true);
    try {
      await apiSend(`/admin/contact-messages/${messageId}`, "DELETE");
      setData((current) =>
        current
          ? {
              ...current,
              total: Math.max(current.total - 1, 0),
              messages: current.messages.filter((message) => message.id !== messageId)
            }
          : current
      );
      setSelectedId(null);
      setFeedback({ kind: "success", text: "Message deleted." });
    } catch (caught) {
      setFeedback({ kind: "error", text: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inbox-layout">
      <div className="admin-card inbox-list-card">
        <div className="admin-card-head">
          <div>
            <h2>
              <Inbox aria-hidden="true" size={17} />
              Messages
            </h2>
            <p>
              {data ? `${data.total} total` : "Loading…"}
              {data && data.unread > 0 ? ` · ${data.unread} new` : ""}
            </p>
          </div>
          <button className="admin-icon-button" type="button" aria-label="Reload messages" onClick={() => void reload()}>
            <RefreshCw aria-hidden="true" size={15} className={loading ? "is-spinning" : undefined} />
          </button>
        </div>

        <div className="inbox-controls">
          <label className="inbox-search">
            <Search aria-hidden="true" size={15} />
            <input
              placeholder="Search name, email, or message"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search messages"
            />
          </label>
          <div className="inbox-filters" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((filter) => (
              <button
                className={cx("inbox-filter", statusFilter === filter.value && "is-active")}
                key={filter.value}
                type="button"
                aria-pressed={statusFilter === filter.value}
                onClick={() => setStatusFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="admin-inline-error" role="alert">
            <AlertCircle aria-hidden="true" size={15} />
            {error}
          </p>
        )}

        <div className="inbox-list" role="list">
          {!loading && messages.length === 0 && (
            <p className="admin-empty">
              {debouncedSearch || statusFilter !== "all"
                ? "No messages match this filter."
                : "No contact messages yet."}
            </p>
          )}
          {messages.map((message) => (
            <button
              className={cx("inbox-item", message.id === selectedId && "is-active", message.status === "NEW" && "is-new")}
              key={message.id}
              type="button"
              role="listitem"
              onClick={() => setSelectedId(message.id)}
            >
              <span className="inbox-item-top">
                <span className="inbox-item-name">{message.name}</span>
                <span className={cx("inbox-status", `is-${message.status.toLowerCase()}`)}>
                  {STATUS_LABELS[message.status]}
                </span>
              </span>
              <span className="inbox-item-subject">{TOPIC_LABELS[message.topic] ?? message.topic}</span>
              <span className="inbox-item-preview">{message.message.slice(0, 90)}</span>
              <span className="inbox-item-date">{formatDateTime(message.createdAt)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="admin-card inbox-detail-card">
        {!selected ? (
          <p className="admin-empty">Select a message to read it.</p>
        ) : (
          <>
            <div className="admin-card-head">
              <div>
                <h2>{TOPIC_LABELS[selected.topic] ?? selected.topic}</h2>
                <p>Received {formatDateTime(selected.createdAt)}</p>
              </div>
              <button
                className="admin-icon-button danger"
                type="button"
                aria-label="Delete message"
                disabled={busy}
                onClick={() => void remove(selected.id)}
              >
                <Trash2 aria-hidden="true" size={15} />
              </button>
            </div>

            <dl className="inbox-meta">
              <div>
                <dt>From</dt>
                <dd>{selected.name}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>
                  <a href={`mailto:${selected.email}`}>{selected.email}</a>
                </dd>
              </div>
              {selected.company && (
                <div>
                  <dt>
                    <Building2 aria-hidden="true" size={13} /> Company
                  </dt>
                  <dd>{selected.company}</dd>
                </div>
              )}
              <div>
                <dt>Signed in</dt>
                <dd>{selected.submittedById ? "Yes — existing account" : "No — anonymous visitor"}</dd>
              </div>
              <div>
                <dt>IP address</dt>
                <dd className="inbox-mono">{selected.ipAddress ?? "—"}</dd>
              </div>
              {selected.handledBy && (
                <div>
                  <dt>Handled by</dt>
                  <dd>
                    {selected.handledBy.name} · {formatDateTime(selected.handledAt)}
                  </dd>
                </div>
              )}
            </dl>

            <div className="inbox-body">{selected.message}</div>

            <div className="inbox-actions">
              <div className="inbox-status-actions" role="group" aria-label="Set status">
                <button
                  className="admin-button"
                  type="button"
                  disabled={busy || selected.status === "OPEN"}
                  onClick={() => void update(selected.id, { status: "OPEN" })}
                >
                  <Mail aria-hidden="true" size={15} />
                  Mark in progress
                </button>
                <button
                  className="admin-button"
                  type="button"
                  disabled={busy || selected.status === "RESOLVED"}
                  onClick={() => void update(selected.id, { status: "RESOLVED" })}
                >
                  <CheckCircle2 aria-hidden="true" size={15} />
                  Mark resolved
                </button>
                <button
                  className="admin-button"
                  type="button"
                  disabled={busy || selected.status === "SPAM"}
                  onClick={() => void update(selected.id, { status: "SPAM" })}
                >
                  <ShieldOff aria-hidden="true" size={15} />
                  Mark spam
                </button>
              </div>

              <a className="admin-button primary" href={`mailto:${selected.email}?subject=${encodeURIComponent(`Re: your ${TOPIC_LABELS[selected.topic] ?? selected.topic} enquiry`)}`}>
                <Mail aria-hidden="true" size={15} />
                Reply by email
              </a>
            </div>

            <label className="admin-field">
              <span>Internal notes</span>
              <textarea
                rows={4}
                placeholder="Context for whoever picks this up next. Never shown to the sender."
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
            <button
              className="admin-button"
              type="button"
              disabled={busy || notes === (selected.adminNotes ?? "")}
              onClick={() => void update(selected.id, { adminNotes: notes })}
            >
              <Save aria-hidden="true" size={15} />
              Save notes
            </button>

            {feedback && (
              <p className={cx("admin-inline-feedback", feedback.kind === "error" && "is-error")} role="status">
                {feedback.text}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
