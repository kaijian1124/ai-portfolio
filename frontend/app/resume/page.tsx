import { SiteShell } from "../../components/site-shell";
import { publicRows, text } from "../../lib/public-data";
export const dynamic = "force-dynamic";
export default async function Resume() {
  const result = await publicRows("resumes", { limit: 1 });
  const resume = result.ok ? result.rows[0] : null;
  return (
    <SiteShell>
      <section className="public-section">
        <p className="eyebrow">Professional background</p>
        <h1>
          Resume<span className="accent">.</span>
        </h1>
        {!result.ok ? (
          <p className="content-message">
            Resume information is temporarily unavailable.
          </p>
        ) : !resume ? (
          <p className="content-message">No Resume has been published yet.</p>
        ) : (
          <>
            <p className="lead">{text(resume, "title")}</p>
            <p>{text(resume, "filename")}</p>
            <a className="button-link" href="/api/resume">
              View / download PDF ↗
            </a>
          </>
        )}
      </section>
    </SiteShell>
  );
}
