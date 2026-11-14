import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AdminNav } from "../../../../../components/admin-nav";
import { getAdminAccess } from "../../../../../lib/admin-session";
import { adminApi } from "../../../../../lib/catalog";

export const dynamic = "force-dynamic";

const pageSize = 20;
const chunksSchema = z.object({
  title: z.string(),
  filename: z.string(),
  index_id: z.uuid().nullable(),
  is_active: z.boolean(),
  total: z.number().int().nonnegative(),
  chunks: z.array(
    z.object({
      ordinal: z.number().int().nonnegative(),
      page: z.number().int().nullable(),
      heading: z.string().nullable(),
      table_header: z.string().nullable(),
      text_content: z.string(),
    }),
  ),
});

export default async function DocumentChunks({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; version: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { id, version } = await params;
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(version).success)
    notFound();

  const access = await getAdminAccess();
  if (access.state === "unauthenticated") redirect("/login");
  if (access.state !== "authorized") redirect("/admin");

  const { page } = await searchParams;
  const pageNumber = typeof page === "string" ? Number(page) : 1;
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 5001)
    notFound();
  const offset = (pageNumber - 1) * pageSize;
  const path = `/admin/document-chunks/${id}/${version}`;
  const result = await adminApi(
    `/api/v1/admin/documents/${id}/versions/${version}/chunks?offset=${offset}&limit=${pageSize}`,
    access.accessToken,
    {},
    chunksSchema,
  );
  const data = result.ok ? result.data : null;
  const lastPage = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  if (data && pageNumber > lastPage) redirect(`${path}?page=${lastPage}`);

  return (
    <main>
      <header>
        <a className="wordmark" href="/admin">
          Portfolio Admin
        </a>
        <a href={`/admin/knowledge-base/${id}`}>Back to document</a>
      </header>
      <AdminNav />
      <section className="admin-panel catalog-panel">
        <p className="eyebrow">Knowledge base</p>
        <h1>
          Ingestion chunks<span className="accent">.</span>
        </h1>
        {data ? (
          <>
            <h2>{data.title}</h2>
            <p className="field-help">
              {data.filename} · {data.total}{" "}
              {data.total === 1 ? "chunk" : "chunks"}
              {data.index_id &&
                (data.is_active
                  ? " · Active index"
                  : " · Latest completed index for this version")}
            </p>
            <p>
              <a
                className="back-link"
                href={`/api/admin/files/documents/${id}?version_id=${version}`}
              >
                View original file ↗
              </a>
            </p>
            {data.chunks.length === 0 ? (
              <p className="content-message">
                No completed chunks are available for this version.
              </p>
            ) : (
              data.chunks.map((chunk) => (
                <article className="version-row" key={chunk.ordinal}>
                  <h3>Chunk {chunk.ordinal + 1}</h3>
                  {(chunk.page !== null || chunk.heading) && (
                    <p className="field-help">
                      {[
                        chunk.page !== null ? `Page ${chunk.page}` : null,
                        chunk.heading,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  {chunk.table_header && (
                    <p className="ingestion-chunk-text">
                      <strong>Table header</strong>
                      {"\n"}
                      {chunk.table_header}
                    </p>
                  )}
                  <p className="ingestion-chunk-text">{chunk.text_content}</p>
                </article>
              ))
            )}
            {lastPage > 1 && (
              <nav className="ingestion-pagination" aria-label="Chunk pages">
                {pageNumber > 1 && (
                  <a href={`${path}?page=${pageNumber - 1}`}>Previous page</a>
                )}
                <span>
                  Page {pageNumber} of {lastPage}
                </span>
                {pageNumber < lastPage && (
                  <a href={`${path}?page=${pageNumber + 1}`}>Next page</a>
                )}
              </nav>
            )}
          </>
        ) : (
          <p className="content-message">
            The document chunks could not be loaded.
          </p>
        )}
      </section>
    </main>
  );
}
