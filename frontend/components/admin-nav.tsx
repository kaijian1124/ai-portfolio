"use client";
import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icon";
const groups: Array<{
  label: string;
  items: Array<[string, string, IconName]>;
}> = [
  { label: "Workspace", items: [["/admin", "Overview", "grid"]] },
  {
    label: "Portfolio",
    items: [
      ["/admin/profile", "Profile", "user"],
      ["/admin/projects", "Projects", "code"],
      ["/admin/skills", "Skills", "layers"],
      ["/admin/experience", "Experience", "briefcase"],
      ["/admin/education", "Education", "book"],
    ],
  },
  {
    label: "Files & knowledge",
    items: [
      ["/admin/resume", "Resume", "document"],
      ["/admin/knowledge-base", "Knowledge base", "book"],
      ["/admin/project-images", "Project images", "grid"],
    ],
  },
  {
    label: "Insights",
    items: [
      ["/admin/monitoring", "AI monitoring", "chart"],
      ["/admin/monitoring/ingestion-jobs", "Ingestion jobs", "layers"],
      ["/admin/activity", "Requests & audit history", "history"],
    ],
  },
];
export function AdminNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <nav className="admin-nav" aria-label="Administration" data-open={open}>
      <button
        type="button"
        className="admin-menu-toggle"
        aria-expanded={open}
        aria-controls="admin-destinations"
        onClick={() => setOpen((v) => !v)}
      >
        Workspace navigation <Icon name={open ? "close" : "menu"} />
      </button>
      <Link className="admin-brand" href="/admin">
        <span className="brand-mark">
          <Icon name="terminal" />
        </span>
        <span>
          Portfolio<small>ADMIN WORKSPACE</small>
        </span>
      </Link>
      <div id="admin-destinations" className="admin-destinations">
        {groups.map((group) => (
          <div className="admin-nav-group" key={group.label}>
            <p>{group.label}</p>
            {group.items.map(([href, label, icon]) => (
              <Link
                key={href}
                href={href}
                aria-current={
                  (
                    href === "/admin"
                      ? pathname === href
                      : pathname === href ||
                        (pathname.startsWith(href + "/") &&
                          !(href === "/admin/monitoring" &&
                            pathname === "/admin/monitoring/ingestion-jobs")) ||
                        (href === "/admin/resume" &&
                          pathname.startsWith("/admin/resume-import/"))
                  )
                    ? "page"
                    : undefined
                }
              >
                <Icon name={icon} size={18} />
                {label}
              </Link>
            ))}
          </div>
        ))}
        <Link className="view-site" href="/">
          View public site <Icon name="external" size={16} />
        </Link>
      </div>
    </nav>
  );
}
