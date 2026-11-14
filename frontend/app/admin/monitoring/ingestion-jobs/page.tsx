import { redirect } from "next/navigation";
import { getAdminAccess } from "../../../../lib/admin-session";
import { adminApi } from "../../../../lib/catalog";
import { AdminNav } from "../../../../components/admin-nav";
import {
  LogPagination,
  logPagination,
  type LogPage,
  type LogQuery,
} from "../../../../components/log-pagination";

type Job = {
  id: string;
  created_at: string;
  status: string;
  attempts: number;
  error: string | null;
  chunk_count: number | null;
};
export const dynamic = "force-dynamic";

export default async function IngestionJobs({
  searchParams,
}: {
  searchParams: Promise<LogQuery>;
}) {
  const access = await getAdminAccess();
  if (access.state !== "authorized") redirect("/login");
  const query = await searchParams;
  const { page, size } = logPagination(query, "jobs");
  const result = await adminApi<LogPage<Job>>(
    `/api/v1/admin/logs/jobs?page=${page}&size=${size}`,
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
        <h1>
          Ingestion jobs<span className="accent">.</span>
        </h1>
        {result.ok ? (
          <>
            {!result.data.rows.length && <p>No jobs on this page.</p>}
            {result.data.rows.map((job) => (
              <div className="version-row" key={job.id}>
                <strong>{job.status}</strong>
                <p>
                  {job.created_at.slice(0, 16).replace("T", " ")} · Attempts{" "}
                  {job.attempts} · Chunks {job.chunk_count ?? "—"}
                </p>
                {job.error && <p>{job.error}</p>}
              </div>
            ))}
            <LogPagination
              query={query}
              path="/admin/monitoring/ingestion-jobs"
              name="jobs"
              label="Ingestion jobs"
              hasNext={result.data.has_next}
            />
          </>
        ) : (
          <p className="content-message">Ingestion jobs are unavailable.</p>
        )}
      </section>
    </main>
  );
}
