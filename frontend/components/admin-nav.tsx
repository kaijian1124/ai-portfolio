import { labels, paths, type Resource } from "../lib/catalog-schema";
export function AdminNav() {
  return (
    <nav className="admin-nav" aria-label="Administration">
      <a href="/admin">Overview</a>
      <a href="/admin/profile">Profile</a>
      {(Object.keys(paths) as Resource[]).map((resource) => (
        <a key={resource} href={`/admin/${paths[resource]}`}>
          {labels[resource]}
        </a>
      ))}
      <a href="/admin/monitoring">AI monitoring</a>
      <a href="/admin/activity">Audit history</a>
    </nav>
  );
}
