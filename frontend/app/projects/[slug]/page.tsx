import { notFound } from "next/navigation";
import { SiteShell } from "../../../components/site-shell";
import { Markdown } from "../../../components/markdown";
import { publicRows, text, imageUrl } from "../../../lib/public-data";
import { safeExternalUrl } from "../../../lib/public-links";
export const dynamic = "force-dynamic";
export default async function Project({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) notFound();
  const result = await publicRows("projects", { slug, limit: 1 });
  if (!result.ok)
    return (
      <SiteShell>
        <p className="content-message">
          Project temporarily unavailable. Please retry.
        </p>
      </SiteShell>
    );
  const project = result.rows[0];
  if (!project) notFound();
  const assets = await publicRows("project_assets", { projectId: project.id });
  const github = safeExternalUrl(text(project, "github_url")),
    demo = safeExternalUrl(text(project, "demo_url"));
  return (
    <SiteShell>
      <article className="public-section">
        <p className="eyebrow">{text(project, "category") || "Project"}</p>
        <h1>
          {text(project, "title")}
          <span className="accent">.</span>
        </h1>
        <p className="lead">{text(project, "summary")}</p>
        {Array.isArray(project.technologies) && (
          <div className="tags">
            {project.technologies
              .filter((t) => typeof t === "string")
              .map((t, i) => (
                <span key={i}>{String(t)}</span>
              ))}
          </div>
        )}
        <div className="form-controls">
          {github && (
            <a href={github} target="_blank" rel="noopener noreferrer">
              GitHub ↗
            </a>
          )}
          {demo && (
            <a href={demo} target="_blank" rel="noopener noreferrer">
              Live demo ↗
            </a>
          )}
        </div>
        {assets.ok && (
          <div className="asset-gallery">
            {assets.rows.map((asset) => {
              const url = imageUrl(text(asset, "storage_path"));
              return url ? (
                <img
                  key={asset.id}
                  src={url}
                  alt={text(asset, "alt_text") || text(project, "title")}
                  loading="lazy"
                />
              ) : null;
            })}
          </div>
        )}
        <Markdown text={text(project, "body_markdown")} />
        <a className="back-link" href="/projects">
          ← All projects
        </a>
      </article>
    </SiteShell>
  );
}
