"use client";

import { useEffect, useState } from "react";
import { warmBackend } from "../lib/backend-readiness";

type ConnectionState = "connecting" | "ready" | "unavailable" | "unconfigured";

export function BackendConnection() {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const controller = new AbortController();
    if (!baseUrl) {
      setState("unconfigured");
      return;
    }
    void warmBackend(baseUrl, { signal: controller.signal })
      .then((ready) => {
        if (!controller.signal.aborted)
          setState(ready ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable");
      });
    return () => controller.abort();
  }, [retry]);

  const messages: Record<ConnectionState, { title: string; detail: string }> = {
    connecting: {
      title: "Connecting to the backend",
      detail:
        "The page is ready to browse. A sleeping backend may take about a minute to start.",
    },
    ready: {
      title: "Backend connected",
      detail:
        "The API is responding. Database content and AI chat will be connected in later steps.",
    },
    unavailable: {
      title: "Backend unavailable",
      detail: "You can stay on this page and try connecting again.",
    },
    unconfigured: {
      title: "Backend URL missing",
      detail:
        "Set NEXT_PUBLIC_API_BASE_URL in .env.local and restart the frontend.",
    },
  };

  return (
    <section className="connection-card" aria-labelledby="connection-heading">
      <p className="eyebrow">Connection check</p>
      <div role="status" aria-live="polite">
        <h2 id="connection-heading">
          <span className={`status-dot ${state}`} />
          {messages[state].title}
        </h2>
        <p>{messages[state].detail}</p>
      </div>
      {state === "unavailable" && (
        <button
          onClick={() => {
            setState("connecting");
            setRetry((value) => value + 1);
          }}
        >
          Retry connection <span aria-hidden="true">↗</span>
        </button>
      )}
      <p className="footnote">Health checks only · No AI requests</p>
    </section>
  );
}
