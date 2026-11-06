import { redirect } from "next/navigation";
import { getAdminAccess } from "../../../lib/admin-session";
import { adminApi } from "../../../lib/catalog";
import { AdminNav } from "../../../components/admin-nav";
export const dynamic = "force-dynamic";
export default async function Activity() {
  const access = await getAdminAccess();
  if (access.state !== "authorized") redirect("/login");
  const result = await adminApi<{
    events: Array<{
      id: string;
      created_at: string;
      entity_type: string;
      entity_id: string;
      action: string;
    }>;
  }>("/api/v1/admin/activity", access.accessToken);
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
          Audit history<span className="accent">.</span>
        </h1>
        {!result.ok ? (
          <p className="content-message">Audit history is unavailable.</p>
        ) : !result.data.events.length ? (
          <p className="content-message">No changes recorded yet.</p>
        ) : (
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
                {result.data.events.map((e) => (
                  <tr key={e.id}>
                    <td>{e.created_at.slice(0, 16).replace("T", " ")}</td>
                    <td>{e.entity_type}</td>
                    <td>{e.action}</td>
                    <td>{e.entity_id.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
