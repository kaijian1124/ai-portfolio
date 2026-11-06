import { safeExternalUrl } from "../lib/public-links";
import { text, type PublicRow } from "../lib/public-data";
export function ProjectCards({ rows }: { rows: PublicRow[] }) {
  return (
    <div className="project-grid">
      {rows.map((row) => {
        const github = safeExternalUrl(text(row, "github_url"));
        return (
          <article className="project-card" key={row.id}>
            <p className="project-label">
              {row.is_featured ? "Featured · " : ""}
              {text(row, "category")}
            </p>
            <h2>
              <a href={`/projects/${text(row, "slug")}`}>
                {text(row, "title")}
              </a>
            </h2>
            <p>{text(row, "summary")}</p>
            {Array.isArray(row.technologies) && (
              <div className="tags">
                {row.technologies
                  .filter((t) => typeof t === "string")
                  .map((tag, i) => (
                    <span key={i}>{String(tag)}</span>
                  ))}
              </div>
            )}
            <div className="project-links">
              <a href={`/projects/${text(row, "slug")}`}>Explore project ↗</a>
              {github && (
                <a href={github} target="_blank" rel="noopener noreferrer">
                  GitHub ↗
                </a>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
