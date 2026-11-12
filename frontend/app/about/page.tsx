import { SiteShell } from "../../components/site-shell";
import { ProfileContent } from "../../components/public-content";
import { Markdown } from "../../components/markdown";
import { publicRows, text, type PublicResult } from "../../lib/public-data";
export const dynamic = "force-dynamic";

function TimelineSection({
  label,
  data,
  organization,
  position,
}: {
  label: string;
  data: PublicResult;
  organization: string;
  position: string;
}) {
  return (
    <section className="public-section">
      <h2>{label}</h2>
      {!data.ok ? (
        <p className="content-message">
          This section is temporarily unavailable.
        </p>
      ) : !data.rows.length ? (
        <p className="content-message">No entries have been published yet.</p>
      ) : (
        data.rows.map((row) => (
          <article className="timeline-entry" key={row.id}>
            <p className="eyebrow">
              {text(row, "started_on")} — {text(row, "ended_on") || "Present"}
            </p>
            <h3>{text(row, position)}</h3>
            <p>
              {text(row, organization)}
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
}

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
      <TimelineSection
        label="Experience"
        data={experience}
        organization="company"
        position="job_title"
      />
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
      <TimelineSection
        label="Education"
        data={education}
        organization="institution"
        position="qualification"
      />
    </SiteShell>
  );
}
