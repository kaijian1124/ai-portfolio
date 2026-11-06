import { Suspense } from "react";
import { SiteShell } from "../components/site-shell";
import { ProfileContent } from "../components/public-content";
import { ProjectCards } from "../components/project-cards";
import { publicRows } from "../lib/public-data";
export const dynamic = "force-dynamic";
async function Featured() {
  const result = await publicRows("projects", { limit: 6 });
  return !result.ok ? (
    <p className="content-message">Projects are temporarily unavailable.</p>
  ) : result.rows.length ? (
    <ProjectCards rows={result.rows} />
  ) : (
    <p className="content-message">No projects have been published yet.</p>
  );
}
export default function Home() {
  return (
    <SiteShell>
      <section className="public-hero">
        <div>
          <p className="eyebrow">Introduction</p>
          <Suspense fallback={<p role="status">Loading profile…</p>}>
            <ProfileContent />
          </Suspense>
          <div className="form-controls">
            <a className="button-link" href="/projects">
              Explore projects ↗
            </a>
            <a href="/chat">Ask about my work</a>
          </div>
        </div>
        <aside className="hero-aside">
          <span className="eyebrow">A closer look</span>
          <h2>
            Explore the work.
            <br />
            Understand the thinking.
          </h2>
          <p>
            Read project details, browse experience, or ask the AI assistant a
            question grounded in published information.
          </p>
          <a href="/resume">View Resume ↗</a>
        </aside>
      </section>
      <section className="projects-section">
        <p className="eyebrow">Selected work</p>
        <h2>Projects</h2>
        <Suspense fallback={<p>Loading projects…</p>}>
          <Featured />
        </Suspense>
        <a className="back-link" href="/projects">
          View all projects ↗
        </a>
      </section>
    </SiteShell>
  );
}
