import Link from "next/link";
import { Suspense } from "react";
import { SiteShell } from "../components/site-shell";
import { ProfileContent } from "../components/public-content";
import { ProjectCards } from "../components/project-cards";
import { Icon } from "../components/icon";
import { publicRows } from "../lib/public-data";
export const dynamic = "force-dynamic";
export default async function Home() {
  const [projects, skills] = await Promise.all([
    publicRows("projects", { limit: 6 }),
    publicRows("skills", { limit: 100 }),
  ]);
  return (
    <SiteShell>
      <section className="public-hero">
        <div className="hero-intro">
          <div className="hero-index">
            <p className="eyebrow">A personal portfolio</p>
            <span className="index-marker">01 / INTRO</span>
          </div>
          <Suspense fallback={<p role="status">Loading profile…</p>}>
            <ProfileContent />
          </Suspense>
          <div className="form-controls">
            <Link className="button-link" href="/projects">
              Explore projects <Icon name="arrow" size={18} />
            </Link>
            <Link href="/resume">
              View Resume <Icon name="external" size={16} />
            </Link>
          </div>
        </div>
        <aside className="hero-aside">
          <div className="aside-topline">
            <span>THE PORTFOLIO, IN CONVERSATION</span>
            <Icon name="message" size={22} />
          </div>
          <h2>
            Go beyond
            <br />
            the introduction.
          </h2>
          <p>
            Curious about a project or a skill? Ask the assistant to explore the
            published work, with sources you can follow.
          </p>
          <Link className="sample-question" href="/chat">
            <span>What technical skills are listed?</span>
            <Icon name="external" size={20} />
          </Link>
          <div className="aside-footer">
            <Icon name="document" size={17} />
            <span>Answers grounded in published information.</span>
          </div>
        </aside>
      </section>
      <div className="portfolio-index">
        <Link href="/projects">
          <span className="index-icon">
            <Icon name="code" />
          </span>
          <span>
            <strong>Projects</strong>
            <small>Decisions, details & outcomes</small>
          </span>
          <Icon name="external" size={18} />
        </Link>
        <Link href="/about">
          <span className="index-icon">
            <Icon name="layers" />
          </span>
          <span>
            <strong>
              {skills.ok && skills.rows.length
                ? `${skills.rows.length}${skills.rows.length === 100 ? "+" : ""} published ${skills.rows.length === 1 ? "skill" : "skills"}`
                : "Skills & experience"}
            </strong>
            <small>Explore the professional background</small>
          </span>
          <Icon name="external" size={18} />
        </Link>
        <Link href="/resume">
          <span className="index-icon">
            <Icon name="document" />
          </span>
          <span>
            <strong>Resume</strong>
            <small>View the current published PDF</small>
          </span>
          <Icon name="external" size={18} />
        </Link>
      </div>
      <section className="projects-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Selected work</p>
            <h2>
              Work, in detail<span className="accent">.</span>
            </h2>
          </div>
          <p>
            A closer look at the projects, the choices behind them, and what was
            built.
          </p>
        </div>
        {!projects.ok ? (
          <p className="content-message">
            Projects are temporarily unavailable.
          </p>
        ) : projects.rows.length ? (
          <ProjectCards rows={projects.rows} headingLevel={3} />
        ) : (
          <p className="content-message">
            No projects have been published yet.
          </p>
        )}
        <Link className="back-link" href="/projects">
          View all projects <Icon name="arrow" size={18} />
        </Link>
      </section>
    </SiteShell>
  );
}
