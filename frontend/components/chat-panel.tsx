"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { warmBackend } from "../lib/backend-readiness";
import { Icon } from "./icon";
import { parseEvents } from "../lib/sse";
type Source = {
  id: string;
  title: string;
  url: string;
  page?: number | null;
  heading?: string | null;
  excerpt: string;
  version_id?: string;
};
type Message = {
  key: string;
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  messageId?: string;
  vote?: number;
};
export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]),
    [question, setQuestion] = useState(""),
    [pending, setPending] = useState(false),
    [status, setStatus] = useState("Preparing assistant…"),
    [ready, setReady] = useState(false),
    [wake, setWake] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const cancel = new AbortController();
    const url = process.env.NEXT_PUBLIC_API_BASE_URL;
    setReady(false);
    setStatus(
      "Preparing assistant. A sleeping server can take about a minute to start.",
    );
    if (url)
      void warmBackend(url, { signal: cancel.signal })
        .then((ok) => {
          if (!cancel.signal.aborted) {
            setReady(ok);
            setStatus(
              ok
                ? "Ready for questions."
                : "Assistant connection unavailable. Try connecting again.",
            );
          }
        })
        .catch(() => {});
    return () => {
      cancel.abort();
      controller.current?.abort();
    };
  }, [wake]);
  useEffect(() => {
    void bottom.current?.scrollIntoView({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [messages, status]);
  async function send(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || pending || !ready) return;
    setQuestion("");
    setPending(true);
    setMessages((old) => [
      ...old,
      { key: crypto.randomUUID(), role: "user", text },
    ]);
    setStatus("Finding verified sources…");
    const cancel = new AbortController();
    controller.current = cancel;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
        signal: cancel.signal,
      });
      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ error: "Assistant unavailable." }));
        setStatus(error.error ?? "Assistant unavailable.");
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const decoder = new TextDecoder();
      let buffer = "",
        answered = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseEvents(buffer);
        buffer = parsed.rest;
        for (const item of parsed.events) {
          const data = item.data as {
            message?: string;
            text?: string;
            sources?: Source[];
            message_id?: string;
          };
          if (item.event === "status")
            setStatus(data.message ?? "Checking sources…");
          if (item.event === "error")
            setStatus(data.message ?? "Assistant unavailable.");
          if (item.event === "answer" && typeof data.text === "string") {
            answered = true;
            setMessages((old) => [
              ...old,
              {
                key: crypto.randomUUID(),
                role: "assistant",
                text: data.text!,
                sources: data.sources ?? [],
                messageId: data.message_id,
              },
            ]);
            setStatus("Answer checked against available source IDs.");
          }
        }
      }
      if (!answered)
        setStatus("No answer was completed. Please try again later.");
    } catch (error) {
      setStatus(
        error instanceof Error && error.name === "AbortError"
          ? "Request cancelled."
          : "Connection interrupted. Your question was not automatically resent.",
      );
    } finally {
      setPending(false);
      controller.current = null;
    }
  }
  async function vote(message: Message, value: number) {
    try {
      const response = await fetch("/api/chat/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: message.messageId, vote: value }),
      });
      if (response.ok)
        setMessages((old) =>
          old.map((m) => (m.key === message.key ? { ...m, vote: value } : m)),
        );
    } catch {
      setStatus("Feedback could not be saved.");
    }
  }
  async function reset() {
    controller.current?.abort();
    try {
      const response = await fetch("/api/chat/reset", { method: "POST" });
      if (!response.ok) throw new Error();
      setMessages([]);
      setStatus("New conversation started.");
    } catch {
      setStatus("Could not start a new conversation. Please try again.");
    }
  }
  return (
    <div className="chat-layout">
      <aside className="chat-aside">
        <p className="eyebrow">Ask about the work</p>
        <h2>Questions, with evidence.</h2>
        <p>
          Ask about published skills, experience, or project details. The
          assistant will say when evidence is missing.
        </p>
        <p className="field-help">
          Conversations are stored for up to 30 days to support follow-ups and
          improve quality. Avoid sharing sensitive information.
        </p>
        <button onClick={reset} disabled={pending}>
          New conversation
        </button>
        <a className="back-link" href="/privacy">
          How data is handled ↗
        </a>
      </aside>
      <section className="chat-box" aria-label="Portfolio assistant">
        <div className="chat-box-header">
          <span>
            <Icon name="message" />
          </span>
          <div>
            <strong>Portfolio assistant</strong>
            <small>Explore the work. Check the sources.</small>
          </div>
        </div>
        <div className="chat-messages" aria-live="polite">
          {!messages.length && (
            <p className="content-message">
              Try asking: “What technical skills are listed?” or “Explain the
              architecture of a published project.”
            </p>
          )}
          {messages.map((message) => (
            <article
              key={message.key}
              className={`chat-message ${message.role}`}
            >
              <span className="small-label">
                {message.role === "user" ? "You" : "Assistant"}
              </span>
              <p>{message.text}</p>
              {message.sources?.length ? (
                <details>
                  <summary>Sources ({message.sources.length})</summary>
                  {message.sources.map((source) => (
                    <div className="source-card" key={source.id}>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {source.title} ↗
                      </a>
                      {source.page ? <span> · Page {source.page}</span> : null}
                      {source.heading && <p>{source.heading}</p>}
                      <blockquote>{source.excerpt.slice(0, 500)}</blockquote>
                    </div>
                  ))}
                </details>
              ) : null}
              {message.messageId && (
                <div className="feedback">
                  <button
                    onClick={() => vote(message, 1)}
                    disabled={Boolean(message.vote)}
                  >
                    Helpful
                  </button>
                  <button
                    onClick={() => vote(message, -1)}
                    disabled={Boolean(message.vote)}
                  >
                    Not helpful
                  </button>
                  {message.vote && <span>Thanks for your feedback.</span>}
                </div>
              )}
            </article>
          ))}
          <div ref={bottom} />
        </div>
        <p role="status" className="chat-status">
          {status}
        </p>
        {!ready && (
          <button onClick={() => setWake((v) => v + 1)}>
            Retry connection
          </button>
        )}
        <form onSubmit={send} className="chat-compose">
          <label className="sr-only" htmlFor="question">
            Your question
          </label>
          <textarea
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={2000}
            rows={3}
            required
            placeholder="Ask about the portfolio…"
            disabled={!ready || pending}
          />
          <button disabled={!ready || pending || !question.trim()}>
            Send ↗
          </button>
          {pending && (
            <button type="button" onClick={() => controller.current?.abort()}>
              Cancel
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
