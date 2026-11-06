import { Markdown } from "./markdown";
import { getPublicProfile, getPublicProjects } from "../lib/portfolio";
import { safeExternalUrl } from "../lib/public-links";

export async function ProfileContent() {
  const result = await getPublicProfile();
  if (result.status === "error") {
    return (
      <>
        <h1 id="page-title">
          Profile temporarily unavailable<span className="accent">.</span>
        </h1>
        <p className="lead">
          We couldn&apos;t load the profile. Please refresh to try again.
        </p>
      </>
    );
  }
  if (!result.data) {
    return (
      <>
        <h1 id="page-title">
          A portfolio
          <br />
          in progress<span className="accent">.</span>
        </h1>
        <p className="lead">No profile has been published yet.</p>
      </>
    );
  }
  return (
    <>
      <h1 id="page-title">
        {result.data.display_name}
        <span className="accent">.</span>
      </h1>
      {result.data.headline && <p className="lead">{result.data.headline}</p>}
      {result.data.location && (
        <p className="profile-location">{result.data.location}</p>
      )}
      {result.data.about_markdown && (
        <Markdown text={result.data.about_markdown} />
      )}
      <div className="project-links">
        {result.data.public_email && (
          <a href={`mailto:${encodeURIComponent(result.data.public_email)}`}>
            Contact by email ↗
          </a>
        )}
        {safeExternalUrl(result.data.github_url) && (
          <a
            href={safeExternalUrl(result.data.github_url)!}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub ↗
          </a>
        )}
        {safeExternalUrl(result.data.linkedin_url) && (
          <a
            href={safeExternalUrl(result.data.linkedin_url)!}
            target="_blank"
            rel="noopener noreferrer"
          >
            LinkedIn ↗
          </a>
        )}
      </div>
    </>
  );
}

export async function ProjectsContent() {
  const result = await getPublicProjects();
  if (result.status === "error") {
    return (
      <p className="content-message" role="status">
        Projects are temporarily unavailable. Please refresh to try again.
      </p>
    );
  }
  if (!result.data.length) {
    return (
      <p className="content-message">No projects have been published yet.</p>
    );
  }
  return (
    <div className="project-grid">
      {result.data.map((project) => {
        const github = safeExternalUrl(project.github_url);
        const demo = safeExternalUrl(project.demo_url);
        return (
          <article className="project-card" key={project.id}>
            {project.is_featured && (
              <span className="project-label">Featured</span>
            )}
            <h3>{project.title}</h3>
            {project.summary && <p>{project.summary}</p>}
            {(github || demo) && (
              <div className="project-links">
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
            )}
          </article>
        );
      })}
    </div>
  );
}
