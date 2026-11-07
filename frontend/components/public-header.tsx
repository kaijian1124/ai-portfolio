"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { Icon } from "./icon";
export function PublicHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="wordmark" href="/" onClick={() => setOpen(false)}>
          <span className="brand-mark">
            <Icon name="terminal" />
          </span>
          <span>
            Portfolio<span className="brand-period">.</span>
            <small>WORK / EXPERIENCE / IDEAS</small>
          </span>
        </Link>
        <button
          ref={button}
          type="button"
          className="menu-toggle"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="public-navigation"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? "close" : "menu"} />
        </button>
        <nav
          id="public-navigation"
          className="public-navigation"
          data-open={open}
          aria-label="Main navigation"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          {[
            ["/about", "About"],
            ["/projects", "Projects"],
            ["/resume", "Resume"],
            ["/chat", "Ask AI"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              aria-current={
                pathname === href || pathname.startsWith(href + "/")
                  ? "page"
                  : undefined
              }
              className={href === "/chat" ? "nav-chat" : undefined}
              onClick={() => setOpen(false)}
            >
              {href === "/chat" && <Icon name="message" size={17} />} {label}
              {href === "/chat" && <Icon name="external" size={16} />}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
