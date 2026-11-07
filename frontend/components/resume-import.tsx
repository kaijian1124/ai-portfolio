"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { fields, paths, type Resource } from "../lib/catalog-schema";
type Candidate = {
  id: string;
  resource: Resource;
  data: Record<string, unknown>;
  evidence_quote: string;
};
type Report = {
  id?: string;
  status: "processing" | "completed" | "failed" | "applied";
  candidates?: Candidate[];
  error?: string;
  result?: Applied;
};
type Applied = {
  status: "applied";
  created: Array<{ id: string; resource: Resource; title: string }>;
  skipped: number;
};
export function ResumeImport({
  resumeId,
  requestId,
}: {
  resumeId: string;
  requestId: string;
}) {
  const [key, setKey] = useState(requestId),
    [report, setReport] = useState<Report | null>(null),
    [result, setResult] = useState<Applied | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const started = useRef(false);
  async function analyze(id: string) {
    setBusy(true);
    setMessage("Extracting evidenced additions. Nothing is being published.");
    try {
      const response = await fetch(`/api/admin/resume-import/${resumeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze", request_id: id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Analysis unavailable.");
      setReport(data);
      if (data.status === "applied") setResult(data.result);
      setMessage(
        data.status === "processing"
          ? "Analysis is still running. Retry the same request shortly; it will not start another paid extraction."
          : data.status === "failed"
            ? `Analysis failed: ${data.error ?? "unknown error"}. Check configuration before starting a new analysis.`
            : "Review each candidate and its source quote. Deselect anything incorrect.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Analysis outcome unconfirmed. Retry the same request.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let id = requestId;
    try {
      const saved = sessionStorage.getItem("resume-import:" + resumeId);
      if (saved && /^[a-f0-9-]{36}$/i.test(saved)) id = saved;
      else sessionStorage.setItem("resume-import:" + resumeId, id);
    } catch {}
    setKey(id);
    void analyze(id);
  }, [resumeId, requestId]);
  async function apply() {
    if (!confirmed || !selected.length) return;
    setBusy(true);
    setMessage("Saving selected new drafts…");
    try {
      const response = await fetch(`/api/admin/resume-import/${resumeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          request_id: key,
          candidate_ids: selected,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error ?? "Save outcome unconfirmed. Retry the same selection.",
        );
      setResult(data);
      setMessage("Drafts saved. Review and publish each item in its editor.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Save outcome unconfirmed. Retry the same selection.",
      );
    } finally {
      setBusy(false);
    }
  }
  function restart() {
    const id = crypto.randomUUID();
    setKey(id);
    setReport(null);
    setResult(null);
    setSelected([]);
    setConfirmed(false);
    try {
      sessionStorage.setItem("resume-import:" + resumeId, id);
    } catch {}
    void analyze(id);
  }
  const candidates = report?.candidates ?? [];
  return (
    <div className="resume-import">
      <p className="save-success">
        Your PDF is already uploaded. AI analysis is optional and does not
        publish the Resume.
      </p>
      <div className="form-controls">
        <Link className="button-link button-secondary" href="/admin/resume">
          Back to files / activate Resume
        </Link>
        <a
          href={`/api/admin/files/resumes/${resumeId}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View uploaded PDF ↗
        </a>
      </div>
      <p className="content-message">
        Resume text is sent to OpenAI for analysis, using the chat AI budget.
        Proposed skills, projects, experience and education need your review.
        Existing matches are skipped on save. Profile is not overwritten; items
        missing required evidence or exact required dates may be omitted.
      </p>
      <p role="status">{message}</p>
      {result ? (
        <>
          <h2>
            Added {result.created.length} draft
            {result.created.length === 1 ? "" : "s"}; skipped {result.skipped}{" "}
            existing item{result.skipped === 1 ? "" : "s"}.
          </h2>
          {result.created.map((item) => (
            <p key={item.id}>
              <a href={`/admin/${paths[item.resource]}/${item.id}`}>
                Review {item.title} ↗
              </a>
            </p>
          ))}
          <p>Existing records and their visibility were preserved.</p>
        </>
      ) : report?.status === "completed" ? (
        <>
          <h2>{candidates.length} candidate additions</h2>
          {!candidates.length && (
            <p>
              No eligible additions were extracted. You can still add records
              manually.
            </p>
          )}
          {candidates.map((item, index) => (
            <article className="version-row" key={item.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Select ${item.resource} candidate ${index + 1}`}
                  checked={selected.includes(item.id)}
                  disabled={busy}
                  onChange={(e) => {
                    setConfirmed(false);
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, item.id]
                        : old.filter((id) => id !== item.id),
                    );
                  }}
                />{" "}
                Add to {item.resource}
              </label>
              <dl>
                {Object.entries(item.data)
                  .filter(
                    ([key, value]) =>
                      key !== "status" &&
                      key !== "sort_order" &&
                      value !== null &&
                      value !== "" &&
                      value !== false,
                  )
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>
                        <strong>
                          {fields[item.resource].find(
                            (field) => field.key === key,
                          )?.label ?? key}
                        </strong>
                      </dt>
                      <dd
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {Array.isArray(value)
                          ? value.join(", ")
                          : String(value)}
                      </dd>
                    </div>
                  ))}
              </dl>
              <blockquote>{item.evidence_quote}</blockquote>
            </article>
          ))}
          {!!candidates.length && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I confirm these additions; existing content must remain
                unchanged.
              </label>
              <div className="form-controls">
                <button
                  disabled={busy || !confirmed || !selected.length}
                  onClick={apply}
                >
                  Add selected as drafts
                </button>
              </div>
            </>
          )}
        </>
      ) : null}
      <div className="form-controls">
        {(!report || report.status === "processing") && !result && (
          <button disabled={busy} onClick={() => analyze(key)}>
            Retry same analysis request
          </button>
        )}
        {(report?.status === "failed" || result) && (
          <button disabled={busy} onClick={restart}>
            Start a new analysis
          </button>
        )}
        <a href={`/admin/resume/${resumeId}`}>Edit Resume metadata</a>
      </div>
    </div>
  );
}
