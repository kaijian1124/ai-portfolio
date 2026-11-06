import { SiteShell } from "../../components/site-shell";
import { ProjectCards } from "../../components/project-cards";
import { publicRows } from "../../lib/public-data";
export const dynamic = "force-dynamic";
export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const query = await searchParams;
  const page = Math.max(1, Math.min(8000, Math.floor(Number(query.page) || 1)));
  const result = await publicRows("projects", {
    limit: 12,
    offset: (page - 1) * 12,
  });
  return (
    <SiteShell>
      <section className="public-section">
        <p className="eyebrow">Selected work</p>
        <h1>
          Projects<span className="accent">.</span>
        </h1>
        <p className="lead">
          Implementation details, engineering choices, and outcomes.
        </p>
        {!result.ok ? (
          <p className="content-message">
            Projects are temporarily unavailable.
          </p>
        ) : !result.rows.length ? (
          <p className="content-message">No published projects on this page.</p>
        ) : (
          <ProjectCards rows={result.rows} />
        )}
        <div className="form-controls">
          {page > 1 && <a href={`/projects?page=${page - 1}`}>Previous</a>}
          {result.ok && result.rows.length === 12 && (
            <a href={`/projects?page=${page + 1}`}>Next</a>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
