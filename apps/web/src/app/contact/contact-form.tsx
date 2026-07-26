"use client";

import { FormEvent, useEffect, useState } from "react";
import { Building2, CheckCircle2, Mail, MessageSquare, Send, Tag, UserRound } from "lucide-react";
import { TurnstileWidget, useTurnstile } from "../../components/turnstile";
import { usePublicSession } from "../../components/public-session";
import { apiBaseUrl } from "../../lib/site";

const topics = [
  { value: "general", label: "General question" },
  { value: "sales", label: "Pricing & plans" },
  { value: "support", label: "Technical support" },
  { value: "security", label: "Security & compliance" },
  { value: "partnership", label: "Partnership" }
] as const;

type Topic = (typeof topics)[number]["value"];

const MIN_MESSAGE = 20;

function mapError(code?: string) {
  switch (code) {
    case "captcha_required":
      return "Please complete the bot-protection challenge before sending.";
    case "captcha_failed":
      return "The bot-protection challenge couldn't be verified. Please try it again.";
    case "captcha_unavailable":
      return "Bot protection is temporarily unavailable. Please try again shortly.";
    case "rate_limited":
      return "You've sent several messages already. Please wait a few minutes before sending another.";
    case "validation_failed":
      return "Please check the form — one of the fields needs attention.";
    default:
      return undefined;
  }
}

export function ContactForm() {
  const turnstile = useTurnstile("contact");
  const session = usePublicSession();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [topic, setTopic] = useState<Topic>("general");
  const [message, setMessage] = useState("");

  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  // Prefill from the session so a signed-in customer does not retype their
  // details just to ask a question.
  useEffect(() => {
    if (session.status !== "signed-in" || !session.user) return;
    setName((current) => current || session.user!.name);
    setEmail((current) => current || session.user!.email);
    setCompany((current) => current || session.organizationName || "");
  }, [session]);

  const canSubmit =
    !busy &&
    name.trim().length >= 2 &&
    email.includes("@") &&
    message.trim().length >= MIN_MESSAGE &&
    turnstile.ready;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const response = await fetch(`${apiBaseUrl}/contact`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          company: company.trim() || undefined,
          topic,
          message: message.trim(),
          ...(turnstile.token ? { turnstileToken: turnstile.token } : {})
        })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        turnstile.reset();
        setError(payload.message ?? mapError(payload.error) ?? "We couldn't send your message. Please try again.");
        return;
      }

      setSent(true);
    } catch {
      turnstile.reset();
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="contact-card contact-success" role="status">
        <span className="contact-success-icon" aria-hidden="true">
          <CheckCircle2 size={26} />
        </span>
        <h2>Message sent</h2>
        <p>
          Thanks for reaching out. Your message is with our team and we usually reply within one business day — check{" "}
          <strong>{email}</strong> for our response.
        </p>
        <div className="contact-success-actions">
          <a className="primary-button" href="/signup">
            Start free while you wait
          </a>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setSent(false);
              setMessage("");
              turnstile.reset();
            }}
          >
            Send another message
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="contact-card" onSubmit={submit} noValidate>
      <div className="contact-grid">
        <div className="auth-field">
          <label htmlFor="contact-name">Your name</label>
          <div className="auth-input-wrap">
            <UserRound aria-hidden="true" size={17} />
            <input
              id="contact-name"
              className="auth-input has-icon"
              type="text"
              autoComplete="name"
              placeholder="Ada Lovelace"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor="contact-email">Work email</label>
          <div className="auth-input-wrap">
            <Mail aria-hidden="true" size={17} />
            <input
              id="contact-email"
              className="auth-input has-icon"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor="contact-company">Company <span className="contact-optional">(optional)</span></label>
          <div className="auth-input-wrap">
            <Building2 aria-hidden="true" size={17} />
            <input
              id="contact-company"
              className="auth-input has-icon"
              type="text"
              autoComplete="organization"
              placeholder="Acme Inc."
              value={company}
              onChange={(event) => setCompany(event.target.value)}
            />
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor="contact-topic">What&apos;s this about?</label>
          <div className="auth-input-wrap">
            <Tag aria-hidden="true" size={17} />
            <select
              id="contact-topic"
              className="auth-input has-icon"
              value={topic}
              onChange={(event) => setTopic(event.target.value as Topic)}
            >
              {topics.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="auth-field">
        <label htmlFor="contact-message">How can we help?</label>
        <div className="auth-input-wrap is-textarea">
          <MessageSquare aria-hidden="true" size={17} />
          <textarea
            id="contact-message"
            className="auth-input has-icon"
            rows={6}
            placeholder="Tell us what you're trying to do, how many servers and people are involved, and anything we should know."
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            aria-describedby="contact-message-hint"
            required
          />
        </div>
        <span className="auth-hint" id="contact-message-hint">
          {message.trim().length < MIN_MESSAGE
            ? `A little more detail helps us answer properly — ${MIN_MESSAGE - message.trim().length} more characters.`
            : "Thanks — that's enough for us to give you a useful answer."}
        </span>
      </div>

      <TurnstileWidget key={turnstile.widgetKey} {...turnstile.widgetProps} />

      {error && (
        <p className="auth-message error" role="alert">
          {error}
        </p>
      )}

      <button className="primary-button large full-width" type="submit" disabled={!canSubmit}>
        {busy ? <span className="auth-spinner" aria-hidden="true" /> : <Send aria-hidden="true" size={17} />}
        {busy ? "Sending…" : "Send message"}
      </button>

      <p className="auth-fineprint">
        We only use your details to answer your enquiry. Prefer email? Reach us at{" "}
        <a href="mailto:support@onshell.cloud">support@onshell.cloud</a>.
      </p>
    </form>
  );
}
