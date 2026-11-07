import Link from "next/link";
import { safeExternalUrl } from "../lib/public-links";
import { text, type PublicRow } from "../lib/public-data";
import { Icon } from "./icon";
export function ProjectCards({
  rows,
  headingLevel = 2,
}: {
  rows: PublicRow[];
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <div className="project-grid">
      {rows.map((row, index) => {
        const github = safeExternalUrl(text(row, "github_url"));
        return (
          <article className="project-card work-card" key={row.id}>
            <Link
              className="project-cover"
              href={`/projects/${text(row, "slug")}`}
              aria-label={`Explore ${text(row, "title")}`}
            >
              <span className="cover-index">
                {String(index + 1).padStart(2, "0")} / PROJECT
              </span>
              <Icon name="code" size={52} />
              <span className="cover-label">
                {row.is_featured ? "FEATURED WORK" : "CASE STUDY"}
              </span>
            </Link>
            <div className="project-card-body">
              <p className="project-label">
                {text(row, "category") || "Project"}
              </p>
              <Heading>
                <Link href={`/projects/${text(row, "slug")}`}>
                  {text(row, "title")}
                </Link>
              </Heading>
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
                <Link href={`/projects/${text(row, "slug")}`}>
                  Explore project <Icon name="external" size={16} />
                </Link>
                {github && (
                  <a href={github} target="_blank" rel="noopener noreferrer">
                    GitHub <Icon name="external" size={15} />
                  </a>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
