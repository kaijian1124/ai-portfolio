export type RequestRow = {
  id: string;
  status: string;
  cost_usd: number;
  latency_ms: number;
  error: string | null;
  created_at: string;
  rag_usage?: Array<{
    stage: string;
    model: string;
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    embedding_tokens?: number;
    rerank_requests?: number;
    input_usd_per_million?: number;
    cached_input_usd_per_million?: number;
    output_usd_per_million?: number;
    embedding_usd_per_million?: number;
    cost_usd?: number;
    usage_status?: string;
  }>;
};

export function RequestTable({ rows }: { rows: RequestRow[] }) {
  return (
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
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.created_at.slice(0, 16).replace("T", " ")}</td>
              <td>{r.status}</td>
              <td>
                {Number(r.cost_usd).toFixed(6)}
                {r.rag_usage?.length ? (
                  <details>
                    <summary>Token and price details</summary>
                    <ul>
                      {r.rag_usage.map((call, index) => (
                        <li key={index}>
                          {call.stage} · {call.model}
                          {call.usage_status === "unknown"
                            ? " · Usage not reported"
                            : ` · USD ${Number(call.cost_usd).toFixed(6)}`}
                          {call.usage_status === "unknown"
                            ? null
                            : call.rerank_requests !== undefined
                              ? ` · ${call.rerank_requests} rerank request (configured estimate)`
                              : call.embedding_tokens !== undefined
                                ? ` · ${call.embedding_tokens} embedding tokens at $${call.embedding_usd_per_million}/M`
                                : ` · ${(call.input_tokens ?? 0) - (call.cached_input_tokens ?? 0)} input at $${call.input_usd_per_million}/M · ${call.cached_input_tokens} cached at $${call.cached_input_usd_per_million}/M · ${call.output_tokens} output at $${call.output_usd_per_million}/M`}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </td>
              <td>{r.latency_ms}</td>
              <td>{r.error ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
