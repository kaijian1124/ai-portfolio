import { redirect } from "next/navigation";
import { getAdminAccess } from "../../../lib/admin-session";
import { adminApi } from "../../../lib/catalog";
import { AdminNav } from "../../../components/admin-nav";
import {
  LogPagination,
  logPagination,
  type LogPage,
  type LogQuery,
} from "../../../components/log-pagination";
import { RequestTable, type RequestRow } from "./request-table";

type AuditRow = {
  id: string;
  created_at: string;
  entity_type: string;
  entity_id: string;
  action: string;
  source: number;
};
export const dynamic = "force-dynamic";

export default async function Activity({
  searchParams,
}: {
  searchParams: Promise<LogQuery>;
}) {
  const access = await getAdminAccess();
  if (access.state !== "authorized") redirect("/login");
  const query = await searchParams;
  const requests = logPagination(query, "requests");
  const audit = logPagination(query, "audit");
  const [requestResult, auditResult] = await Promise.all([
    adminApi<LogPage<RequestRow>>(
      `/api/v1/admin/logs/requests?page=${requests.page}&size=${requests.size}`,
      access.accessToken,
    ),
    adminApi<LogPage<AuditRow>>(
      `/api/v1/admin/logs/audit?page=${audit.page}&size=${audit.size}`,
      access.accessToken,
    ),
  ]);

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
          Requests &amp; audit history<span className="accent">.</span>
        </h1>
        <h2>Recent requests</h2>
        {requestResult.ok ? (
          <>
            {requestResult.data.rows.length ? (
              <RequestTable rows={requestResult.data.rows} />
            ) : (
              <p>No requests on this page.</p>
            )}
            <LogPagination
              query={query}
              path="/admin/activity"
              name="requests"
              label="Recent requests"
              hasNext={requestResult.data.has_next}
            />
          </>
        ) : (
          <p className="content-message">Recent requests are unavailable.</p>
        )}
        <h2>Audit history</h2>
        {auditResult.ok ? (
          <>
            {auditResult.data.rows.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Content</th>
                      <th>Action</th>
                      <th>Record</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditResult.data.rows.map((event) => (
                      <tr key={event.source + ":" + event.id}>
                        <td>
                          {event.created_at.slice(0, 16).replace("T", " ")}
                        </td>
                        <td>{event.entity_type}</td>
                        <td>{event.action}</td>
                        <td>{event.entity_id.slice(0, 8)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No audit events on this page.</p>
            )}
            <LogPagination
              query={query}
              path="/admin/activity"
              name="audit"
              label="Audit history"
              hasNext={auditResult.data.has_next}
            />
          </>
        ) : (
          <p className="content-message">Audit history is unavailable.</p>
        )}
      </section>
    </main>
  );
}
