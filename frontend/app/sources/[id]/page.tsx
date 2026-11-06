import { notFound } from "next/navigation";
import { z } from "zod";
import { SiteShell } from "../../../components/site-shell";
import { backendFetch } from "../../../lib/backend";
export const dynamic = "force-dynamic";
export default async function Source({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  let source: {
    title: string;
    page?: number;
    heading?: string;
    excerpt: string;
    version_id: string;
  } | null = null;
  try {
    const response = await backendFetch(`/api/v1/sources/${id}`);
    if (response.ok) source = await response.json();
  } catch {}
  return (
    <SiteShell>
      <section className="public-section">
        <p className="eyebrow">Source excerpt</p>
        {source ? (
          <>
            <h1>{source.title}</h1>
            {source.page && <p>Page {source.page}</p>}
            {source.heading && <h2>{source.heading}</h2>}
            <blockquote className="source-excerpt">{source.excerpt}</blockquote>
            <p className="field-help">
              Version: {source.version_id.slice(0, 8)}. The original document is
              not publicly downloadable.
            </p>
          </>
        ) : (
          <>
            <h1>
              Source unavailable<span className="accent">.</span>
            </h1>
            <p>
              The source may have been withdrawn, replaced, or temporarily
              unavailable.
            </p>
          </>
        )}
        <a className="back-link" href="/chat">
          ← Back to assistant
        </a>
      </section>
    </SiteShell>
  );
}
