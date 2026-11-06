import { redirect } from "next/navigation";
import { getAdminAccess } from "../../../lib/admin-session";
import { adminApi } from "../../../lib/catalog";
import { AdminNav } from "../../../components/admin-nav";
export const dynamic = "force-dynamic";
type Metrics = {
  average_citations: number;
  evaluation: {
    case_count: number;
    created_at: string;
    metrics: Record<string, number | null>;
  } | null;
  ingestion_cost_usd: number;
  ingestion_tokens: number;
  requests: number;
  prompt_tokens: number;
  output_tokens: number;
  embedding_tokens: number;
  estimated_cost_usd: number;
  average_latency_ms: number;
  errors: number;
  feedback: { positive: number; negative: number };
  recent_requests: Array<{
    id: string;
    status: string;
    cost_usd: number;
    latency_ms: number;
    error: string | null;
    created_at: string;
  }>;
  jobs: Array<{
    id: string;
    status: string;
    attempts: number;
    error: string | null;
    chunk_count: number | null;
  }>;
};
export default async function Monitoring() {
  const access = await getAdminAccess();
  if (access.state !== "authorized") redirect("/login");
  const result = await adminApi<Metrics>(
    "/api/v1/admin/monitoring",
    access.accessToken,
  );
  return (
    <main>
      <header>
        <a className="wordmark" href="/admin">
          Portfolio Admin
        </a>
      </header>
      <AdminNav />
      <section className="admin-panel catalog-panel">
        <p className="eyebrow">Last 30 days</p>
        <h1>
          AI monitoring<span className="accent">.</span>
        </h1>
        {!result.ok ? (
          <p className="content-message">
            Monitoring is unavailable. Check the AI database migration.
          </p>
        ) : (
          <>
            <div className="metric-grid">
              {[
                [
                  "Indexing cost (USD)",
                  Number(result.data.ingestion_cost_usd).toFixed(4),
                ],
                ["Indexing tokens", result.data.ingestion_tokens],
                ["Requests", result.data.requests],
                [
                  "Estimated cost (USD)",
                  Number(result.data.estimated_cost_usd).toFixed(4),
                ],
                ["Input tokens", result.data.prompt_tokens],
                ["Output tokens", result.data.output_tokens],
                ["Embedding tokens", result.data.embedding_tokens],
                [
                  "Average latency (ms)",
                  Math.round(result.data.average_latency_ms),
                ],
                ["Errors", result.data.errors],
                ["Helpful feedback", result.data.feedback.positive],
                ["Unhelpful feedback", result.data.feedback.negative],
              ].map(([name, value]) => (
                <div className="metric" key={String(name)}>
                  <span>{name}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <p className="field-help">
              Costs are application estimates, not provider invoices.
              Interrupted requests conservatively consume their reserved budget.
              Messages are retained for 30 days.
            </p>
            <h2>Retrieval and evaluation</h2>
            <p>
              Average citations per answer:{" "}
              {Number(result.data.average_citations).toFixed(2)}. Citations
              alone do not prove factual correctness.
            </p>
            {result.data.evaluation ? (
              <>
                <p>
                  Latest reviewed dataset: {result.data.evaluation.case_count}{" "}
                  cases · {result.data.evaluation.created_at.slice(0, 10)}
                </p>
                <div className="metric-grid">
                  {Object.entries(result.data.evaluation.metrics).map(
                    ([key, value]) => (
                      <div className="metric" key={key}>
                        <span>{key.replaceAll("_", " ")}</span>
                        <strong>
                          {value === null ? "—" : Number(value).toFixed(3)}
                        </strong>
                      </div>
                    ),
                  )}
                </div>
              </>
            ) : (
              <p>
                No evaluation run recorded. Generate source-based cases and
                review them before running the evaluation CLI.
              </p>
            )}
            <p className="field-help">
              Source recall and term coverage are measured proxies. Manually
              review faithfulness and contradictions against the current
              sources.
            </p>
            <h2>Recent requests</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Status</th>
                    <th>USD</th>
                    <th>Latency ms</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.recent_requests.map((r) => (
                    <tr key={r.id}>
                      <td>{r.created_at.slice(0, 16).replace("T", " ")}</td>
                      <td>{r.status}</td>
                      <td>{Number(r.cost_usd).toFixed(4)}</td>
                      <td>{r.latency_ms}</td>
                      <td>{r.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h2>Ingestion jobs</h2>
            {!result.data.jobs.length ? (
              <p>No jobs yet.</p>
            ) : (
              result.data.jobs.map((j) => (
                <div className="version-row" key={j.id}>
                  <strong>{j.status}</strong>
                  <p>
                    Attempts: {j.attempts} · Chunks: {j.chunk_count ?? "—"}
                    {j.error ? ` · ${j.error}` : ""}
                  </p>
                </div>
              ))
            )}
          </>
        )}
      </section>
    </main>
  );
}
