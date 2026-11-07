import { SiteShell } from "../../components/site-shell";
import { Icon } from "../../components/icon";
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
        <p className="lead">
          The current published version, ready to view or download.
        </p>
        {!result.ok ? (
          <p className="content-message">
            Resume information is temporarily unavailable.
          </p>
        ) : !resume ? (
          <p className="content-message">No Resume has been published yet.</p>
        ) : (
          <article className="resume-sheet">
            <div className="resume-document">
              <Icon name="document" size={76} />
            </div>
            <div>
              <span className="status-pill">
                <Icon name="check" size={15} />
                Current published version
              </span>
              <h2>{text(resume, "title")}</h2>
              <p className="resume-filename">{text(resume, "filename")}</p>
              <a className="button-link" href="/api/resume">
                View / download PDF <Icon name="external" size={18} />
              </a>
              <p className="field-help">
                Opens the selected Resume PDF in your browser.
              </p>
            </div>
          </article>
        )}
      </section>
    </SiteShell>
  );
}
