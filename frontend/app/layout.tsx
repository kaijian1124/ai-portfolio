import type { Metadata } from "next";
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
        <BackendWakeup />
        {children}
      </body>
    </html>
  );
}
