import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { getAdminAccess } from "../../../lib/admin-session";
import { catalogList } from "../../../lib/catalog";
import {
  labels,
  recordTitle,
  resourceFromPath,
} from "../../../lib/catalog-schema";
import { AdminNav } from "../../../components/admin-nav";
import { UploadForm } from "../../../components/upload-form";
import { CatalogOperation } from "../../../components/catalog-form";
export const dynamic = "force-dynamic";
export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ resource: string }>;
  searchParams: Promise<{ offset?: string; trash?: string }>;
}) {
  const { resource: path } = await params;
  const resource = resourceFromPath(path);
  if (!resource) notFound();
  const access = await getAdminAccess();
  if (access.state === "unauthenticated") redirect("/login");
  if (access.state !== "authorized") redirect("/admin");
  const query = await searchParams;
  const offset = Math.max(0, Math.min(100000, Number(query.offset) || 0));
  const trash = query.trash === "1";
  const [result, projects] = await Promise.all([
    catalogList(resource, access.accessToken, offset, trash),
    ["documents", "project_assets"].includes(resource)
      ? catalogList("projects", access.accessToken)
      : Promise.resolve(null),
  ]);
  const records = result.ok ? result.data.records : [];
  const visible = trash ? records.filter((r) => r.deleted_at) : records;
  return (
    <main>
      <header>
        <a className="wordmark" href="/admin">
          Portfolio Admin
        </a>
        <a href="/">View site ↗</a>
      </header>
      <AdminNav />
      <section className="admin-panel catalog-panel">
        <p className="eyebrow">Content management</p>
        <h1>
          {labels[resource]}
          <span className="accent">.</span>
        </h1>
        {!trash && resource === "resumes" && (
          <>
            <div className="resume-flow">
              <div>
                <span className="small-label">01 / Upload</span>
                <strong>Save the PDF</strong>The original stays available even
                if AI analysis fails.
              </div>
              <div>
                <span className="small-label">02 / Optional analysis</span>
                <strong>Preview additions</strong>Confirm new drafts without
                changing existing content.
              </div>
              <div>
                <span className="small-label">03 / Publish</span>
                <strong>Activate Resume</strong>Choose the version visitors can
                view and download.
              </div>
            </div>
            <UploadForm kind="resume" />
          </>
        )}
        {!trash && resource === "documents" && (
          <UploadForm
            kind="knowledge"
            projects={projects?.ok ? projects.data.records : []}
            documents={records}
          />
        )}
        {!trash && resource === "project_assets" && (
          <UploadForm
            kind="image"
            projects={projects?.ok ? projects.data.records : []}
          />
        )}
        <div className="form-controls">
          {!["resumes", "documents", "project_assets"].includes(resource) &&
            !trash && (
              <a className="button-link" href={`/admin/${path}/new`}>
                Add {labels[resource]}
              </a>
            )}
          <a href={`/admin/${path}${trash ? "" : "?trash=1"}`}>
            {trash ? "Back to active items" : "View trash"}
          </a>
        </div>
        {!result.ok ? (
          <p className="content-message" role="status">
            Could not load content. Confirm the backend is running and remaining
            database migrations are applied.
          </p>
        ) : !visible.length ? (
          <p className="content-message">
            {trash
              ? "Trash is empty."
              : "No items yet. Add your actual content to get started."}
          </p>
        ) : (
          <div className="catalog-grid">
            {visible.map((record) => (
              <article className="project-card" key={record.id}>
                <p className="eyebrow">
                  {String(record.status ?? "")}
                  {record.is_active ? " · Active Resume" : ""}
                </p>
                <h2>{recordTitle(record)}</h2>
                {resource === "documents" && (
                  <>
                    <p>
                      Processing: {String(record.ingestion_status)} · AI use:{" "}
                      {record.approved_for_chat ? "Approved" : "Not approved"}
                    </p>
                    {record.active_version &&
                    (record.desired_version !== record.active_version ||
                      record.desired_index !== record.active_index) ? (
                      <p className="field-help">
                        A previous version remains active. Review processing and
                        approval before publishing the replacement.
                      </p>
                    ) : null}
                  </>
                )}
                <div className="project-links">
                  {!trash && (
                    <a href={`/admin/${path}/${record.id}`}>Edit / details ↗</a>
                  )}
                  {["resumes", "documents"].includes(resource) && !trash && (
                    <a href={`/api/admin/files/${resource}/${record.id}`}>
                      View original ↗
                    </a>
                  )}
                </div>
                {resource === "resumes" && !trash && !record.is_active && (
                  <CatalogOperation
                    resource={resource}
                    record={record}
                    requestId={randomUUID()}
                    operation="activate"
                  />
                )}
                <CatalogOperation
                  resource={resource}
                  record={record}
                  requestId={randomUUID()}
                  operation={trash ? "restore" : "delete"}
                />
              </article>
            ))}
          </div>
        )}
        <div className="form-controls">
          {offset > 0 && (
            <a
              href={`/admin/${path}?offset=${Math.max(0, offset - 100)}${trash ? "&trash=1" : ""}`}
            >
              Previous
            </a>
          )}
          {records.length === 100 && (
            <a
              href={`/admin/${path}?offset=${offset + 100}${trash ? "&trash=1" : ""}`}
            >
              Next
            </a>
          )}
        </div>
      </section>
    </main>
  );
}
