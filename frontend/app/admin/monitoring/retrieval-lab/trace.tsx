"use client";

import { useState } from "react";

type Hit = { id: string; rank: number; score?: number | null };
type Source = {
  id: string;
  kind: string;
  title: string;
  role?: string;
  chars?: number;
  excerpt?: string;
};
type Trace = {
  route?: string;
  model?: string;
  top_p?: number | null;
  temperature?: number | null;
  answer_max_output_tokens?: number;
  context_excluded?: Source[];
  searches: Array<{
    query: string;
    scope: string | null;
    latency_ms: number;
    vector: Hit[] | null;
    keyword: Hit[] | null;
    fused: Hit[];
    kept: string[];
  }>;
  context: Source[];
  citations: Source[];
  source_status?: string;
};
type Chunk = {
  title: string;
  document_id: string;
  version_id: string;
  index_id: string;
  ordinal: number;
  page: number | null;
  heading: string | null;
  table_header: string | null;
  text: string;
};

const sections = [
  "Query",
  "Vector",
  "Keyword",
  "RRF / Top K",
  "Rerank",
  "Context",
  "Generation",
  "Citations",
] as const;

function ChunkDetails({ source, label }: { source: Source; label: string }) {
  const [chunk, setChunk] = useState<Chunk | null>();
  const [loading, setLoading] = useState(false);

  async function load() {
    if (source.kind !== "document" || loading || chunk) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/retrieval-lab/chunks/${source.id}`,
        { cache: "no-store" },
      );
      setChunk(response.ok ? await response.json() : null);
    } catch {
      setChunk(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="retrieval-chunk"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>{label}</summary>
      {source.excerpt && (chunk || source.kind !== "document") && (
        <>
          <p className="field-help">Excerpt sent to the model</p>
          <p className="ingestion-chunk-text">{source.excerpt}</p>
        </>
      )}
      {loading && <p role="status">Loading indexed chunk…</p>}
      {chunk === null && <p>Indexed chunk is no longer available.</p>}
      {chunk && (
        <>
          <p>
            {chunk.title} · Chunk {chunk.ordinal + 1}
            {chunk.page !== null && ` · PDF page ${chunk.page}`}
          </p>
          {chunk.heading && <p>{chunk.heading}</p>}
          <p className="field-help">Index {chunk.index_id}</p>
          {chunk.table_header && (
            <p className="ingestion-chunk-text">{chunk.table_header}</p>
          )}
          <p className="ingestion-chunk-text">{chunk.text}</p>
          <a
            href={`/api/admin/files/documents/${chunk.document_id}?version_id=${chunk.version_id}`}
          >
            Open original version
          </a>
        </>
      )}
    </details>
  );
}

export function RetrievalTrace({
  id,
  question,
  summary,
  traced,
}: {
  id: string;
  question: string | null;
  summary: string;
  traced: boolean;
}) {
  const [trace, setTrace] = useState<Trace | null>();
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [section, setSection] = useState<(typeof sections)[number]>("Query");

  async function load() {
    if (!traced || loading || trace) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/retrieval-lab/runs/${id}`, {
        cache: "no-store",
      });
      const result = response.ok ? await response.json() : null;
      setTrace(result?.trace ?? null);
      setAnswer(result?.answer ?? null);
    } catch {
      setTrace(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="version-row retrieval-run"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>
        <strong>{question ?? "Question unavailable"}</strong>
        <span className="field-help">{summary}</span>
      </summary>
      {!traced && <p>No stage data was recorded for this request.</p>}
      {loading && <p role="status">Loading retrieval stages…</p>}
      {trace === null && (
        <p role="status">
          Trace is unavailable. Close and reopen the request to retry.
        </p>
      )}
      {trace && (
        <>
          <div
            className="retrieval-stages"
            role="group"
            aria-label="Retrieval stages"
          >
            {sections.map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={section === item}
                onClick={() => setSection(item)}
              >
                {item}
              </button>
            ))}
          </div>
          {section === "Query" && (
            <>
              <p>Route {trace.route ?? "Unavailable"}</p>
              {trace.searches.map((search, index) => (
                <p key={index}>
                  {search.query} ·{" "}
                  {search.scope
                    ? `Scope ${search.scope}`
                    : "All approved sources"}{" "}
                  · {search.latency_ms} ms per search round
                </p>
              ))}
            </>
          )}
          {(["Vector", "Keyword", "RRF / Top K"] as const).map(
            (step) =>
              section === step && (
                <div key={step}>
                  {!trace.searches.length && (
                    <p>Document retrieval did not run.</p>
                  )}
                  {trace.searches.map((search, index) => {
                    const hits =
                      step === "Vector"
                        ? search.vector
                        : step === "Keyword"
                          ? search.keyword
                          : search.fused;
                    return (
                      <div key={index}>
                        <h3>
                          Search {index + 1} ·{" "}
                          {search.scope
                            ? `Scope ${search.scope}`
                            : "All approved sources"}
                        </h3>
                        {!hits?.length && (
                          <p>
                            {hits ? "No matches." : "Stage ranks unavailable."}
                          </p>
                        )}
                        {hits?.map((hit) => (
                          <ChunkDetails
                            key={hit.id}
                            source={{ id: hit.id, kind: "document", title: "" }}
                            label={`#${hit.rank} · ${hit.id.slice(0, 8)}${hit.score != null ? ` · RRF ${hit.score.toFixed(4)}` : ""}${step === "RRF / Top K" ? (search.kept.includes(hit.id) ? " · Kept" : " · Excluded") : ""}`}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              ),
          )}
          {section === "Rerank" && (
            <p>Independent reranker skipped. Candidate order comes from RRF.</p>
          )}
          {section === "Generation" && (
            <>
              <p>
                Model {trace.model ?? "Unavailable"} · Top P{" "}
                {trace.top_p ?? "model default"} · Temperature{" "}
                {trace.temperature ?? "model default"} · Max output{" "}
                {trace.answer_max_output_tokens ?? "—"} tokens
              </p>
              {answer && <p className="ingestion-chunk-text">{answer}</p>}
            </>
          )}
          {(section === "Context" || section === "Citations") && (
            <>
              {section === "Citations" &&
                trace.source_status === "withdrawn" && (
                  <p>
                    Sources changed before delivery. Citations were discarded.
                  </p>
                )}
              {(section === "Context" ? trace.context : trace.citations).map(
                (source, index) => (
                  <ChunkDetails
                    key={source.id}
                    source={source}
                    label={`#${index + 1} · ${source.title}${source.role === "neighbor" ? " · Adjacent chunk" : ""}${source.chars != null ? ` · ${source.chars} characters` : ""}`}
                  />
                ),
              )}
              {!(section === "Context" ? trace.context : trace.citations)
                .length && <p>No sources recorded at this stage.</p>}
              {section === "Context" && !!trace.context_excluded?.length && (
                <>
                  <h3>Excluded by context limits</h3>
                  {trace.context_excluded.map((source) => (
                    <ChunkDetails
                      key={source.id}
                      source={source}
                      label={source.title}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}
