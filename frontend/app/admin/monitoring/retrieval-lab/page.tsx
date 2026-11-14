import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminNav } from "../../../../components/admin-nav";
import { getAdminAccess } from "../../../../lib/admin-session";
import { adminApi } from "../../../../lib/catalog";
import { RetrievalTrace } from "./trace";

export const dynamic = "force-dynamic";

type Run = {
  id: string;
  created_at: string;
  question: string | null;
  status: string;
  latency_ms: number | null;
  cost_usd: number;
  traced: boolean;
};

export default async function RetrievalLab() {
  const access = await getAdminAccess();
  if (access.state !== "authorized") redirect("/login");
  const result = await adminApi<{ runs: Run[] }>(
    "/api/v1/admin/retrieval-runs",
    access.accessToken,
  );

  return (
    <main>
      <header>
        <Link className="wordmark" href="/admin">
          Portfolio Admin
        </Link>
      </header>
      <AdminNav />
      <section className="admin-panel catalog-panel">
        <Link href="/admin/monitoring">Back to AI monitoring</Link>
        <h1>Retrieval Lab</h1>
        <p className="field-help">
          Latest 50 chat requests from the last 30 days.
        </p>
        {!result.ok ? (
          <p role="status">Retrieval runs are unavailable.</p>
        ) : result.data.runs.length === 0 ? (
          <p>Send a question in Ask AI to see a request here.</p>
        ) : (
          result.data.runs.map((run) => (
            <RetrievalTrace
              key={run.id}
              id={run.id}
              question={run.question}
              summary={`${run.created_at.slice(0, 16).replace("T", " ")} UTC · ${run.status} · ${run.latency_ms ?? "—"} ms · $${Number(run.cost_usd).toFixed(5)}`}
              traced={run.traced}
            />
          ))
        )}
      </section>
    </main>
  );
}
