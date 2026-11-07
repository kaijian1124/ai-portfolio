import type { Metadata } from "next";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";
import { BackendWakeup } from "../components/backend-wakeup";

export const metadata: Metadata = {
  title: "Professional Portfolio",
  description:
    "Projects, technical experience, and a grounded AI portfolio assistant.",
  robots: { index: process.env.NODE_ENV === "production", follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <BackendWakeup />
        {children}
      </body>
    </html>
  );
}
