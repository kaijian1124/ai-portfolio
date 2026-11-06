import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getAdminAccess } from "../../../../lib/admin-session";
import { adminApi, catalogGet, catalogList } from "../../../../lib/catalog";
import { labels, resourceFromPath } from "../../../../lib/catalog-schema";
import { AdminNav } from "../../../../components/admin-nav";
import { CatalogForm, ReindexForm } from "../../../../components/catalog-form";
export const dynamic = "force-dynamic";
export default async function Editor({
  params,
}: {
  params: Promise<{ resource: string; id: string }>;
}) {
  const { resource: path, id } = await params;
  const resource = resourceFromPath(path);
  if (!resource) notFound();
  if (id !== "new" && !z.uuid().safeParse(id).success) notFound();
  if (
    id === "new" &&
    ["resumes", "documents", "project_assets"].includes(resource)
  )
    redirect(`/admin/${path}`);
  const access = await getAdminAccess();
  if (access.state === "unauthenticated") redirect("/login");
  if (access.state !== "authorized") redirect("/admin");
  const [result, projects, versions] = await Promise.all([
    id === "new"
      ? Promise.resolve(null)
      : catalogGet(resource, id, access.accessToken),
    resource === "documents"
      ? catalogList("projects", access.accessToken)
      : Promise.resolve(null),
    resource === "documents" && id !== "new"
      ? adminApi<{
          versions: Array<{
            id: string;
            filename: string;
            created_at: string;
            processing?: { status: string; error?: string; attempts: number };
          }>;
        }>(`/api/v1/admin/documents/${id}/versions`, access.accessToken)
      : Promise.resolve(null),
  ]);
  return (
    <main>
      <header>
        <a className="wordmark" href="/admin">
          Portfolio Admin
        </a>
        <a href={`/admin/${path}`}>Back to {labels[resource]}</a>
      </header>
      <AdminNav />
      <section className="admin-panel catalog-panel">
        <p className="eyebrow">Content editor</p>
        <h1>
          {id === "new" ? "Add" : "Edit"} {labels[resource]}
          <span className="accent">.</span>
        </h1>
        {result && !result.ok ? (
          <p className="content-message">
            The item could not be loaded. Reload before making changes.
          </p>
        ) : result?.ok && result.data.record.deleted_at ? (
          <p className="content-message">
            This item is in trash. Restore it before editing.
          </p>
        ) : (
          <CatalogForm
            resource={resource}
            initial={result?.ok ? result.data.record : null}
            requestId={randomUUID()}
            projects={projects?.ok ? projects.data.records : []}
          />
        )}
        {resource === "documents" && id !== "new" && (
          <>
            <h2>Document versions</h2>
            <p className="field-help">
              Processing is queued durably. GitHub Actions runs the worker;
              scheduled starts can be delayed.
            </p>
            <ReindexForm id={id} requestId={randomUUID()} />
            {versions?.ok &&
              versions.data.versions.map((v) => (
                <article className="version-row" key={v.id}>
                  <strong>{v.filename}</strong>
                  <p>
                    {new Date(v.created_at).toISOString().slice(0, 10)} ·{" "}
                    {v.processing?.status ?? "uploaded"}
                    {v.processing?.error ? ` · ${v.processing.error}` : ""}
                  </p>
                  <a
                    href={`/api/admin/files/documents/${id}?version_id=${v.id}`}
                  >
                    View this version ↗
                  </a>
                </article>
              ))}
          </>
        )}
      </section>
    </main>
  );
}
