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
  chat_cached_input_tokens?: number;
  usage_unreported?: number;
  output_tokens: number;
  embedding_tokens: number;
  estimated_cost_usd: number;
  average_latency_ms: number;
  errors: number;
  feedback: { positive: number; negative: number };
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
        <nav className="ingestion-pagination" aria-label="Monitoring pages">
          <a href="/admin/monitoring/retrieval-lab">Retrieval Lab</a>
          <a href="/admin/monitoring/ingestion-jobs">Ingestion jobs</a>
          <a href="/admin/activity">Requests &amp; audit history</a>
        </nav>
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
                ["Cached input tokens", result.data.chat_cached_input_tokens ?? 0],
                ["Output tokens", result.data.output_tokens],
                ["Embedding tokens", result.data.embedding_tokens],
                [
                  "Average latency (ms)",
                  Math.round(result.data.average_latency_ms),
                ],
                ["Errors", result.data.errors],
                ["Failed requests without metering", result.data.usage_unreported ?? 0],
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
          </>
        )}
      </section>
    </main>
  );
}
