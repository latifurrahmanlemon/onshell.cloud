"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  MessageSquarePlus,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  User as UserIcon
} from "lucide-react";
import { cx } from "@onshell/ui";
import { ApiError, consoleApi, type AiMessage, type AiStatus, type AiThreadSummary } from "./api";

/** Suggested openers, so an empty thread is not a blank page. */
const STARTERS = [
  "How do I attach an SSH key to a host in Onshell?",
  "My SSH session says permission denied (publickey) — what should I check?",
  "Write a systemd unit that restarts my Node app on failure.",
  "Explain what `chmod 600 ~/.ssh/id_ed25519` does and why it matters."
];

/**
 * Minimal Markdown rendering: fenced code blocks, inline code, and bold.
 *
 * Deliberately not a full Markdown parser — model output is untrusted input, so
 * everything is rendered as React text nodes rather than injected HTML. There is
 * no path here for markup in a reply to become live DOM.
 */
function renderContent(content: string) {
  const blocks = content.split(/```/);

  return blocks.map((block, index) => {
    // Odd indices are inside a fence.
    if (index % 2 === 1) {
      const newline = block.indexOf("\n");
      const firstLine = newline === -1 ? "" : block.slice(0, newline).trim();
      // A short first line with no spaces is a language hint, not code.
      const isLanguage = firstLine.length > 0 && firstLine.length < 20 && !firstLine.includes(" ");
      const code = newline === -1 ? block : isLanguage ? block.slice(newline + 1) : block;

      return (
        <pre className="ai-code" key={index}>
          {isLanguage && <span className="ai-code-lang">{firstLine}</span>}
          <code>{code.replace(/\n$/, "")}</code>
        </pre>
      );
    }

    return (
      <div className="ai-prose" key={index}>
        {block
          .split("\n")
          .filter((line, lineIndex, lines) => !(line === "" && lines[lineIndex - 1] === ""))
          .map((line, lineIndex) => (
            <p key={lineIndex}>{renderInline(line)}</p>
          ))}
      </div>
    );
  });
}

/** Inline `code` and **bold**, again as text nodes only. */
function renderInline(line: string) {
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The AI assistant view: a thread list plus a conversation pane.
 *
 * Messages are persisted server-side, so a reload restores the conversation and
 * platform admins can review threads for support and abuse handling.
 */
export function AssistantView({ onUpgrade }: { onUpgrade?: () => void }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [threads, setThreads] = useState<AiThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  const quotaExhausted = useMemo(
    () => status !== null && status.limit !== null && status.remaining !== null && status.remaining <= 0,
    [status]
  );

  useEffect(() => {
    let active = true;
    void Promise.all([consoleApi.aiStatus().catch(() => null), consoleApi.aiThreads().catch(() => [])]).then(
      ([nextStatus, nextThreads]) => {
        if (!active) return;
        setStatus(nextStatus);
        setThreads(nextThreads);
      }
    );
    return () => {
      active = false;
    };
  }, []);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending]);

  const openThread = useCallback(async (threadId: string) => {
    setActiveThreadId(threadId);
    setLoadingThread(true);
    setError(null);
    try {
      const thread = await consoleApi.aiThread(threadId);
      setMessages(thread.messages);
    } catch {
      setError("Could not load that conversation.");
      setMessages([]);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  function startNewThread() {
    setActiveThreadId(null);
    setMessages([]);
    setError(null);
    setDraft("");
  }

  async function deleteThread(threadId: string) {
    try {
      await consoleApi.aiDeleteThread(threadId);
      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      if (threadId === activeThreadId) startNewThread();
    } catch {
      setError("Could not delete that conversation.");
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;

    setSending(true);
    setError(null);
    setDraft("");

    // Optimistic echo so the question appears instantly; replaced by the
    // server's persisted copy once the reply lands.
    const optimisticId = `pending-${Date.now()}`;
    setMessages((current) => [
      ...current,
      { id: optimisticId, role: "USER", content: message, createdAt: new Date().toISOString() }
    ]);

    try {
      const result = await consoleApi.aiSend({
        message,
        ...(activeThreadId ? { threadId: activeThreadId } : {})
      });

      setMessages((current) => [
        ...current.filter((entry) => entry.id !== optimisticId),
        result.userMessage,
        result.assistantMessage
      ]);
      setActiveThreadId(result.thread.id);
      setThreads((current) => {
        const without = current.filter((thread) => thread.id !== result.thread.id);
        return [result.thread, ...without];
      });
      setStatus((current) =>
        current
          ? { ...current, used: result.usage.used, limit: result.usage.limit, remaining: result.usage.remaining }
          : current
      );
    } catch (caught) {
      // Keep the question visible so the user can retry without retyping.
      setMessages((current) => current.filter((entry) => entry.id !== optimisticId));
      setDraft(message);

      if (caught instanceof ApiError) {
        if (caught.status === 402) {
          setError("You've used all the AI messages included with your plan this month. Upgrade for more.");
          setStatus((current) => (current ? { ...current, remaining: 0 } : current));
        } else if (caught.status === 429) {
          setError("Too many requests in a row. Give it a few seconds and try again.");
        } else if (caught.status === 503) {
          setError("The AI assistant isn't configured yet. Ask a platform admin to enable it.");
        } else {
          setError("The assistant couldn't answer that. Please try again.");
        }
      } else {
        setError("Network error. Please check your connection and try again.");
      }
    } finally {
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(draft);
  }

  if (status && !status.enabled) {
    return (
      <section className="panel ai-disabled" aria-labelledby="ai-disabled-title">
        <span className="ai-disabled-icon" aria-hidden="true">
          <Bot size={28} />
        </span>
        <h2 id="ai-disabled-title">The AI assistant isn&apos;t switched on yet</h2>
        <p>
          Once a platform admin adds an OpenAI API key in <strong>Admin → Settings → AI Assistant</strong>, you&apos;ll
          be able to ask questions about Onshell.cloud and get help with Linux, shell, and SSH work right here.
        </p>
      </section>
    );
  }

  return (
    <section className="ai-layout" aria-label="AI assistant">
      <aside className="ai-sidebar">
        <button className="ai-new" type="button" onClick={startNewThread}>
          <MessageSquarePlus aria-hidden="true" size={16} />
          New conversation
        </button>

        <div className="ai-threads" role="list">
          {threads.length === 0 && <p className="ai-threads-empty">No conversations yet.</p>}
          {threads.map((thread) => (
            <div className={cx("ai-thread", thread.id === activeThreadId && "is-active")} key={thread.id} role="listitem">
              <button type="button" onClick={() => void openThread(thread.id)}>
                <span className="ai-thread-title">{thread.title}</span>
                <span className="ai-thread-meta">
                  {thread.messageCount} messages · {relativeTime(thread.lastMessageAt)}
                </span>
              </button>
              <button
                className="ai-thread-delete"
                type="button"
                aria-label={`Delete conversation "${thread.title}"`}
                onClick={() => void deleteThread(thread.id)}
              >
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </div>
          ))}
        </div>

        {status && (
          <div className="ai-quota">
            {status.limit === null ? (
              <span>
                <Sparkles aria-hidden="true" size={13} /> Unlimited messages
                {status.planName ? ` on ${status.planName}` : ""}
              </span>
            ) : (
              <>
                <div className="ai-quota-bar" aria-hidden="true">
                  <span style={{ width: `${Math.min((status.used / Math.max(status.limit, 1)) * 100, 100)}%` }} />
                </div>
                <span>
                  {status.used} / {status.limit} messages used this month
                </span>
                {quotaExhausted && onUpgrade && (
                  <button className="text-link" type="button" onClick={onUpgrade}>
                    Upgrade for more
                  </button>
                )}
              </>
            )}
            {status.model && <span className="ai-quota-model">Model: {status.model}</span>}
          </div>
        )}
      </aside>

      <div className="ai-main">
        <div className="ai-scroll" ref={scrollRef}>
          {loadingThread && <p className="ai-loading">Loading conversation…</p>}

          {!loadingThread && messages.length === 0 && (
            <div className="ai-welcome">
              <span className="ai-welcome-icon" aria-hidden="true">
                <Bot size={26} />
              </span>
              <h2>Onshell Assistant</h2>
              <p>
                Ask about Onshell.cloud — hosts, the vault, permissions, plans — or about the Linux, shell, and SSH work
                in front of you. Never paste real passwords or private keys.
              </p>
              <div className="ai-starters">
                {STARTERS.map((starter) => (
                  <button key={starter} type="button" onClick={() => void send(starter)} disabled={sending}>
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((entry) => (
            <article className={cx("ai-message", entry.role === "USER" ? "is-user" : "is-assistant")} key={entry.id}>
              <span className="ai-message-avatar" aria-hidden="true">
                {entry.role === "USER" ? <UserIcon size={15} /> : <Bot size={15} />}
              </span>
              <div className="ai-message-body">
                <span className="ai-message-role">{entry.role === "USER" ? "You" : "Assistant"}</span>
                {renderContent(entry.content)}
              </div>
            </article>
          ))}

          {sending && (
            <article className="ai-message is-assistant" aria-live="polite">
              <span className="ai-message-avatar" aria-hidden="true">
                <Bot size={15} />
              </span>
              <div className="ai-message-body">
                <span className="ai-message-role">Assistant</span>
                <span className="ai-typing" aria-label="Thinking">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </article>
          )}
        </div>

        {error && (
          <p className="ai-error" role="alert">
            <TriangleAlert aria-hidden="true" size={15} />
            {error}
          </p>
        )}

        <form className="ai-composer" onSubmit={onSubmit}>
          <label className="sr-only" htmlFor="ai-draft">
            Message the assistant
          </label>
          <textarea
            id="ai-draft"
            rows={2}
            placeholder={quotaExhausted ? "Monthly message limit reached" : "Ask about a command, a config, or Onshell itself…"}
            value={draft}
            disabled={sending || quotaExhausted}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter inserts a newline, as in every chat UI.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <button
            className="primary-button"
            type="submit"
            disabled={sending || quotaExhausted || draft.trim().length === 0}
          >
            <Send aria-hidden="true" size={16} />
            <span className="ai-send-label">Send</span>
          </button>
        </form>
        <p className="ai-disclaimer">
          Answers are generated and can be wrong — verify before running anything destructive. Conversations are stored
          in your workspace and may be reviewed by platform admins for support.
        </p>
      </div>
    </section>
  );
}
