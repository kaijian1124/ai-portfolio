import type { ReactNode } from "react";
export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="/">
          Portfolio<span className="accent">.</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="/about">About</a>
          <a href="/projects">Projects</a>
          <a href="/resume">Resume</a>
          <a className="nav-chat" href="/chat">
            Ask AI ↗
          </a>
        </nav>
      </header>
      {children}
      <footer>
        <span>Professional portfolio</span>
        <a href="/privacy">Privacy</a>
        <a href="/login">Admin</a>
      </footer>
    </main>
  );
}
