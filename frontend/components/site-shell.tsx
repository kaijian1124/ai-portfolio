import type { ReactNode } from "react";
import Link from "next/link";
import { PublicHeader } from "./public-header";
import { Icon } from "./icon";
export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="site-frame">
      <PublicHeader />
      <main id="main-content" tabIndex={-1} className="public-main">
        {children}
      </main>
      <footer className="site-footer">
        <div>
          <Link className="footer-brand" href="/">
            <Icon name="terminal" size={18} /> Portfolio.
          </Link>
          <p>Explore the work. Follow the thinking.</p>
        </div>
        <div className="footer-links">
          <Link href="/about">About</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/login">
            Admin <Icon name="external" size={14} />
          </Link>
        </div>
        <span className="footer-note">A living collection of work.</span>
      </footer>
    </div>
  );
}
