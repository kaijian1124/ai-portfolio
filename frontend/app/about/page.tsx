import { SiteShell } from "../../components/site-shell";
import { ProfileContent } from "../../components/public-content";
import { Markdown } from "../../components/markdown";
import { publicRows, text } from "../../lib/public-data";
import { getPublicProfile } from "../../lib/portfolio";
export const dynamic = "force-dynamic";
export default async function About() {
  const [skills, experience, education] = await Promise.all([
    publicRows("skills"),
    publicRows("experiences"),
    publicRows("education"),
  ]);
  return (
    <SiteShell>
      <section className="public-section">
        <p className="eyebrow">About</p>
        <ProfileContent />
      </section>
      <section className="public-section">
        <h2>Technical skills</h2>
        {!skills.ok ? (
          <p className="content-message">Skills are temporarily unavailable.</p>
        ) : !skills.rows.length ? (
          <p className="content-message">No skills have been published yet.</p>
        ) : (
          <div className="skill-grid">
            {skills.rows.map((row) => (
              <article key={row.id}>
                <span className="eyebrow">{text(row, "category")}</span>
                <h3>{text(row, "name")}</h3>
                <p>{text(row, "description")}</p>
              </article>
            ))}
          </div>
        )}
      </section>
      {[
        ["Experience", experience, "company", "job_title"],
        ["Education", education, "institution", "qualification"],
      ].map(([label, result, organization, position]) => {
        const data = result as typeof experience;
        return (
          <section className="public-section" key={String(label)}>
            <h2>{String(label)}</h2>
            {!data.ok ? (
              <p className="content-message">
                This section is temporarily unavailable.
              </p>
            ) : !data.rows.length ? (
              <p className="content-message">
                No entries have been published yet.
              </p>
            ) : (
              data.rows.map((row) => (
                <article className="timeline-entry" key={row.id}>
                  <p className="eyebrow">
                    {text(row, "started_on")} —{" "}
                    {text(row, "ended_on") || "Present"}
                  </p>
                  <h3>{text(row, String(position))}</h3>
                  <p>
                    {text(row, String(organization))}
                    {text(row, "field_of_study")
                      ? ` · ${text(row, "field_of_study")}`
                      : ""}
                  </p>
                  <Markdown text={text(row, "description_markdown")} />
                </article>
              ))
            )}
          </section>
        );
      })}
    </SiteShell>
  );
}
