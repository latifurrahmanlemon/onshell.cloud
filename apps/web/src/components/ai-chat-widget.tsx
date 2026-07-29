"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Bot, MessageCircle, RotateCcw, Send, TriangleAlert, X } from "lucide-react";
import { cx } from "@onshell/ui";
import { ApiError, consoleApi } from "../app/console/api";
import { apiBaseUrl } from "../lib/site";
import { useSiteConfig } from "../lib/site-config";
import { usePublicSession } from "./public-session";
import "./ai-chat.css";

/** Guest conversations live in sessionStorage so they survive page navigation. */
const GUEST_STORAGE_KEY = "onshell-ai-guest-chat";

/** Turns replayed to the stateless guest endpoint. Must not exceed the server's cap. */
const GUEST_HISTORY_TURNS = 10;

const GUEST_STARTERS = [
  "What is Onshell.cloud?",
  "How is this different from PuTTY or a terminal on my laptop?",
  "Where are my SSH keys stored?",
  "What do I get on the free plan?"
];

const MEMBER_STARTERS = [
  "How do I attach an SSH key to a host?",
  "My session says permission denied (publickey) — what should I check?",
  "Write a systemd unit that restarts my Node app on failure.",
  "How do I give a teammate access to just one host?"
];

interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/**
 * Minimal Markdown rendering: fenced code blocks, inline code, and bold.
 *
 * Deliberately not a full Markdown parser — model output is untrusted input, so
 * everything becomes React text nodes rather than injected HTML. There is no path
 * here for markup in a reply to turn into live DOM.
 */
function renderContent(content: string) {
  return content.split(/```/).map((block, index) => {
    // Odd indices are inside a fence.
    if (index % 2 === 1) {
      const newline = block.indexOf("\n");
      const firstLine = newline === -1 ? "" : block.slice(0, newline).trim();
      // A short first line with no spaces is a language hint, not code.
      const isLanguage = firstLine.length > 0 && firstLine.length < 20 && !firstLine.includes(" ");
      const code = newline === -1 ? block : isLanguage ? block.slice(newline + 1) : block;

      return (
        <pre className="aiw-code" key={index}>
          {isLanguage && <span className="aiw-code-lang">{firstLine}</span>}
          <code>{code.replace(/\n$/, "")}</code>
        </pre>
      );
    }

    return (
      <div className="aiw-prose" key={index}>
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
  return line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function readGuestTurns(): ChatTurn[] {
  try {
    const raw = window.sessionStorage.getItem(GUEST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatTurn[];
    return Array.isArray(parsed) ? parsed.slice(-40) : [];
  } catch {
    // Corrupt or unavailable storage is not worth surfacing — start fresh.
    return [];
  }
}

/**
 * The assistant, everywhere: a bubble in the bottom-right corner of every page.
 *
 * It has two modes behind one UI. Signed-in visitors talk to /ai/messages, so
 * their conversation is persisted against their workspace and picks up where
 * they left it. Anonymous visitors talk to /public/ai/chat, which stores nothing
 * server-side — the client replays the recent turns instead, and keeps them in
 * sessionStorage so moving between marketing pages does not reset the chat.
 *
 * Renders nothing at all until an admin has enabled the assistant.
 */
export function AiChatWidget() {
  const config = useSiteConfig();
  const session = usePublicSession();
  const signedIn = session.status === "signed-in";

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaHit, setQuotaHit] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  /** Guards the one-time history load per mode, so reopening does not refetch. */
  const [restored, setRestored] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A signed-in user and a guest have different conversations; switching between
  // them (logging out on a public page) has to clear the panel.
  useEffect(() => {
    setRestored(false);
    setTurns([]);
    setThreadId(null);
  }, [signedIn]);

  // Restore the previous conversation the first time the panel is opened.
  useEffect(() => {
    if (!open || restored || session.status === "loading") return;
    setRestored(true);

    if (!signedIn) {
      setTurns(readGuestTurns());
      return;
    }

    void consoleApi
      .aiThreads()
      .then(async (threads) => {
        const latest = threads[0];
        if (!latest) return;
        const thread = await consoleApi.aiThread(latest.id);
        setThreadId(thread.id);
        setTurns(
          thread.messages
            .filter((entry) => entry.role !== "SYSTEM")
            .map((entry) => ({
              id: entry.id,
              role: entry.role === "USER" ? ("user" as const) : ("assistant" as const),
              content: entry.content
            }))
        );
      })
      .catch(() => {
        // An empty panel is a fine outcome; the composer still works.
      });
  }, [open, restored, session.status, signedIn]);

  // Persist guest turns so navigation does not lose the conversation.
  useEffect(() => {
    if (signedIn || !restored) return;
    try {
      window.sessionStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(turns.slice(-40)));
    } catch {
      // Private-mode storage limits are not worth interrupting the chat for.
    }
  }, [restored, signedIn, turns]);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, sending, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape closes the panel, matching every other overlay in the product.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;

      setSending(true);
      setError(null);
      setDraft("");

      const asked: ChatTurn = { id: `local-${Date.now()}`, role: "user", content: message };
      const history = [...turns, asked];
      setTurns(history);

      try {
        if (signedIn) {
          const result = await consoleApi.aiSend({ message, ...(threadId ? { threadId } : {}) });
          setThreadId(result.thread.id);
          setTurns([
            ...history.filter((turn) => turn.id !== asked.id),
            { id: result.userMessage.id, role: "user", content: result.userMessage.content },
            { id: result.assistantMessage.id, role: "assistant", content: result.assistantMessage.content }
          ]);
          return;
        }

        const response = await fetch(`${apiBaseUrl}/public/ai/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message,
            history: turns.slice(-GUEST_HISTORY_TURNS * 2).map(({ role, content }) => ({ role, content }))
          })
        });
        const payload = (await response.json().catch(() => ({}))) as { reply?: string; message?: string };
        if (!response.ok) throw new ApiError(response.status, payload.message ?? "request_failed");

        setTurns([
          ...history,
          { id: `reply-${Date.now()}`, role: "assistant", content: payload.reply ?? "" }
        ]);
      } catch (caught) {
        // Keep the question in the composer so it can be retried without retyping.
        setTurns(history.filter((turn) => turn.id !== asked.id));
        setDraft(message);

        if (caught instanceof ApiError) {
          if (caught.status === 402) {
            setQuotaHit(true);
            setError("You've used all the AI messages included with your plan this month.");
          } else if (caught.status === 429) {
            setError("That's a lot of questions at once — give it a few seconds and try again.");
          } else if (caught.status === 503) {
            setError("The assistant isn't available right now.");
          } else if (caught.status === 401) {
            setError("Your session expired. Please sign in again.");
          } else {
            setError("Couldn't answer that. Please try again.");
          }
        } else {
          setError("Network error. Check your connection and try again.");
        }
      } finally {
        setSending(false);
      }
    },
    [sending, signedIn, threadId, turns]
  );

  function reset() {
    setTurns([]);
    setThreadId(null);
    setError(null);
    setQuotaHit(false);
    setDraft("");
    if (!signedIn) {
      try {
        window.sessionStorage.removeItem(GUEST_STORAGE_KEY);
      } catch {
        // Nothing to clean up if storage is unavailable.
      }
    }
    inputRef.current?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(draft);
  }

  // No bubble at all until an admin has switched the assistant on — an inert
  // chat button is worse than no chat button.
  if (!config?.ai.enabled) return null;

  const starters = signedIn ? MEMBER_STARTERS : GUEST_STARTERS;

  return (
    <div className="aiw-root">
      {open && (
        <section aria-label="Onshell Assistant" className="aiw-panel">
          <header className="aiw-head">
            <span aria-hidden="true" className="aiw-head-icon">
              <Bot size={17} />
            </span>
            <span className="aiw-head-id">
              <strong>Onshell Assistant</strong>
              <span>{signedIn ? "Saved to your workspace" : "Ask anything about Onshell"}</span>
            </span>
            {turns.length > 0 && (
              <button aria-label="Start a new chat" className="aiw-icon-btn" onClick={reset} type="button">
                <RotateCcw aria-hidden="true" size={15} />
              </button>
            )}
            <button aria-label="Close chat" className="aiw-icon-btn" onClick={() => setOpen(false)} type="button">
              <X aria-hidden="true" size={16} />
            </button>
          </header>

          <div className="aiw-scroll" ref={scrollRef}>
            {turns.length === 0 && (
              <div className="aiw-welcome">
                <p>
                  {signedIn
                    ? "Ask about your hosts, the vault, permissions, or the Linux and SSH work in front of you. Never paste real passwords or private keys."
                    : "Ask about Onshell.cloud — how it works, what it costs, how your keys are protected — or about SSH and Linux in general."}
                </p>
                <div className="aiw-starters">
                  {starters.map((starter) => (
                    <button disabled={sending} key={starter} onClick={() => void send(starter)} type="button">
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((turn) => (
              <div className={cx("aiw-msg", turn.role === "user" ? "is-user" : "is-assistant")} key={turn.id}>
                {renderContent(turn.content)}
              </div>
            ))}

            {sending && (
              <div aria-live="polite" className="aiw-msg is-assistant">
                <span aria-label="Thinking" className="aiw-typing">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>

          {error && (
            <p className="aiw-error" role="alert">
              <TriangleAlert aria-hidden="true" size={15} />
              <span>
                {error}
                {quotaHit && (
                  <>
                    {" "}
                    <a href="/console?view=billing">See plans</a>
                  </>
                )}
              </span>
            </p>
          )}

          <form className="aiw-composer" onSubmit={onSubmit}>
            <label className="sr-only" htmlFor="aiw-draft">
              Message the assistant
            </label>
            <textarea
              disabled={sending}
              id="aiw-draft"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter inserts a newline, as in every chat UI.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              placeholder="Ask a question…"
              ref={inputRef}
              rows={1}
              value={draft}
            />
            <button aria-label="Send" className="aiw-send" disabled={sending || draft.trim().length === 0} type="submit">
              <Send aria-hidden="true" size={16} />
            </button>
          </form>
          <p className="aiw-foot">
            Answers are generated and can be wrong — verify before running anything destructive.
          </p>
        </section>
      )}

      <button
        aria-expanded={open}
        aria-label={open ? "Close the assistant" : "Ask the Onshell Assistant"}
        className={cx("aiw-bubble", open && "is-open")}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? <X aria-hidden="true" size={20} /> : <MessageCircle aria-hidden="true" size={20} />}
        {!open && <span className="aiw-bubble-label">Ask AI</span>}
      </button>
    </div>
  );
}
