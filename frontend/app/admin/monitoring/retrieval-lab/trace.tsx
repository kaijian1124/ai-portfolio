"use client";

import { useRef, useState } from "react";

type Hit = { id: string; rank: number; score?: number | null };
type Source = {
  id: string;
  kind: string;
  title: string;
  role?: string;
  chars?: number;
  excerpt?: string;
  index_id?: string | null;
};
type Trace = {
  route?: string;
  query_resolution?: string;
  resolved_query?: string;
  memory_used?: boolean;
  reranking?: Array<{
    scope: string | null;
    model: string;
    status: string;
    latency_ms?: number;
    before: string[];
    after: Array<{ id: string; score?: number; kept: boolean }>;
  }>;
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

const ingestionStages = [
  "Document Parsing",
  "Cleaning & Metadata",
  "Chunking",
  "Admin Review",
  "Vector Indexing",
] as const;
type IngestionStage = (typeof ingestionStages)[number];
const sections = [
  ...ingestionStages,
  "Query",
  "Hybrid Search",
  "Recall",
  "Reranking",
  "Answer Generation",
  "Chunk Citations",
] as const;

type IndexRecord = {
  metadata: {
    format?: string;
    sections?: number;
    pages_with_text?: number;
    pdf_pages?: number;
    running_lines_removed?: number;
    footnote_sections?: number;
    toc_pages_removed?: number;
    watermark_lines_removed?: number;
    pdf_annotations_skipped?: number;
    pdf_tables_reconstructed?: number;
    docx_tables?: number;
    docx_contents_blocks_removed?: number;
    unresolved_glyphs?: number;
    cleaning?: string[];
    chunker?: string;
    source_sha256?: string;
  } | null;
  approved_at: string | null;
  chunks: number;
  model: string | null;
  hash: string | null;
};

function IngestionEvidence({
  stage,
  trace,
}: {
  stage: IngestionStage;
  trace: Trace;
}) {
  const [records, setRecords] = useState<Record<string, IndexRecord | null>>(
    {},
  );
  const loadingIndexes = useRef(new Set<string>());
  const indexes = new Map<string, Source>();
  for (const source of trace.context) {
    if (source.index_id && !indexes.has(source.index_id))
      indexes.set(source.index_id, source);
  }
  async function load(id: string) {
    if (id in records || loadingIndexes.current.has(id)) return;
    loadingIndexes.current.add(id);
    let record: IndexRecord | null = null;
    try {
      const response = await fetch(`/api/admin/retrieval-lab/indexes/${id}`, {
        cache: "no-store",
      });
      if (response.ok) record = await response.json();
    } finally {
      setRecords((previous) => ({ ...previous, [id]: record }));
      loadingIndexes.current.delete(id);
    }
  }
  return (
    <>
      <p>
        These stages ran during ingestion for the document indexes used as
        context in this request.
      </p>
      {!indexes.size && (
        <p>
          No document index was recorded for this request. Older traces may lack
          index IDs.
        </p>
      )}
      {Array.from(indexes, ([id, source]) => (
        <details
          key={id}
          className="retrieval-chunk"
          onToggle={(event) => {
            if (event.currentTarget.open) void load(id).catch(() => {});
          }}
        >
          <summary>
            {source.title} · {id.slice(0, 8)}
          </summary>
          {!(id in records) ? (
            <p role="status">Loading index details…</p>
          ) : !records[id] ? (
            <p>Index details are unavailable.</p>
          ) : (
            <IndexStage stage={stage} record={records[id]} />
          )}
        </details>
      ))}
    </>
  );
}

function IndexStage({
  stage,
  record,
}: {
  stage: IngestionStage;
  record: IndexRecord;
}) {
  const metadata = record.metadata;
  if (stage === "Vector Indexing")
    return (
      <p>
        {record.chunks} indexed chunks · Model {record.model ?? "Unavailable"}
      </p>
    );
  if (stage === "Admin Review")
    return record.approved_at ? (
      <>
        <p>Embedding approved on {record.approved_at}.</p>
        <p>Approved snapshot: {record.hash}</p>
      </>
    ) : (
      <p>No before-embedding approval was recorded for this index.</p>
    );
  if (!metadata)
    return <p>This index has no stored parsing or cleaning record.</p>;
  if (stage === "Document Parsing")
    return (
      <p>
        Format {metadata.format} · {metadata.sections} extracted sections ·{" "}
        {metadata.pdf_pages !== undefined
          ? `${metadata.pages_with_text ?? 0} of ${metadata.pdf_pages} PDF pages with text`
          : "Page numbers unavailable for this format"}
      </p>
    );
  if (stage === "Chunking")
    return (
      <p>
        {record.chunks} chunks · Chunker {metadata.chunker ?? "Unavailable"}.
        Open a chunk in Recall or Chunk Citations to see its text and location.
      </p>
    );
  return (
    <>
      {metadata.running_lines_removed !== undefined && (
        <p>
          {metadata.running_lines_removed} repeated margin lines removed ·{" "}
          {metadata.footnote_sections ?? 0} separate footnote sections
        </p>
      )}
      {metadata.toc_pages_removed !== undefined && (
        <p>
          {metadata.toc_pages_removed} contents-only pages skipped ·{" "}
          {metadata.watermark_lines_removed ?? 0} watermark lines removed ·{" "}
          {metadata.pdf_annotations_skipped ?? 0} PDF annotations excluded ·{" "}
          {metadata.pdf_tables_reconstructed ?? 0} regular tables reconstructed
        </p>
      )}
      {metadata.docx_tables !== undefined && (
        <p>
          {metadata.docx_tables} Word tables reconstructed ·{" "}
          {metadata.docx_contents_blocks_removed ?? 0} contents blocks skipped
        </p>
      )}
      {!!metadata.unresolved_glyphs && (
        <p>
          {metadata.unresolved_glyphs} unreadable glyphs remain. Check the
          original before approval.
        </p>
      )}
      <ul>
        {metadata.cleaning?.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      <p>
        Stored chunk metadata includes its page or heading when available,
        section, text offsets, and any detected table header.
      </p>
    </>
  );
}

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
          {ingestionStages.some((item) => item === section) && (
            <IngestionEvidence
              stage={section as IngestionStage}
              trace={trace}
            />
          )}
          {section === "Query" && (
            <>
              <p>Route {trace.route ?? "Unavailable"}</p>
              {trace.query_resolution === "clarification_requested" && (
                <p>{answer ?? "Asked the visitor to clarify the project."}</p>
              )}
              {trace.query_resolution === "rewritten" && (
                <p>Resolved query: {trace.resolved_query}</p>
              )}
              {trace.memory_used && (
                <p>Conversation project state was available.</p>
              )}
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
              ((section === "Hybrid Search" && step !== "RRF / Top K") ||
                (section === "Recall" && step === "RRF / Top K")) && (
                <div key={step}>
                  <h3>
                    {step === "Vector"
                      ? "Semantic Search"
                      : step === "Keyword"
                        ? "Keyword Search"
                        : "Fused Candidates (RRF / Top K)"}
                  </h3>
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
          {section === "Reranking" && (
            <>
              {!trace.reranking?.length && (
                <p>
                  {trace.searches.length
                    ? "No reranker record is available for this request."
                    : "Skipped because document retrieval did not run."}
                </p>
              )}
              {trace.reranking?.map((run, index) => (
                <div key={index}>
                  <h3>
                    Round {index + 1} · {run.model}
                  </h3>
                  <p>
                    {run.status}
                    {run.latency_ms !== undefined &&
                      ` · ${run.latency_ms} ms`}{" "}
                    · {run.scope ?? "All approved sources"}
                  </p>
                  <h4>RRF baseline</h4>
                  {run.before.length ? (
                    <ol>
                      {run.before.map((id) => (
                        <li key={id}>{id}</li>
                      ))}
                    </ol>
                  ) : (
                    <p>No candidates.</p>
                  )}
                  {!!run.after.length && <h4>Reranked order</h4>}
                  {run.after.map((hit, rank) => (
                    <ChunkDetails
                      key={hit.id}
                      source={{ id: hit.id, kind: "document", title: "" }}
                      label={`#${rank + 1} · ${hit.id.slice(0, 8)} ${hit.score !== undefined ? `· Score ${hit.score.toFixed(4)} ` : ""}· ${hit.kept ? "Kept" : "Excluded"}`}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
          {section === "Answer Generation" && (
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
          {(section === "Recall" || section === "Chunk Citations") && (
            <>
              {section === "Chunk Citations" &&
                trace.source_status === "withdrawn" && (
                  <p>
                    Sources changed before delivery. Citations were discarded.
                  </p>
                )}
              {section === "Recall" && <h3>Context sent to the model</h3>}
              {(section === "Recall" ? trace.context : trace.citations).map(
                (source, index) => (
                  <ChunkDetails
                    key={source.id}
                    source={source}
                    label={`#${index + 1} · ${source.title}${source.role === "neighbor" ? " · Adjacent chunk" : ""}${source.chars != null ? ` · ${source.chars} characters` : ""}`}
                  />
                ),
              )}
              {!(section === "Recall" ? trace.context : trace.citations)
                .length && <p>No sources recorded at this stage.</p>}
              {section === "Recall" && !!trace.context_excluded?.length && (
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
