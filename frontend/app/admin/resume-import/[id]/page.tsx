import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getAdminAccess } from "../../../../lib/admin-session";
import { catalogGet } from "../../../../lib/catalog";
import { AdminNav } from "../../../../components/admin-nav";
import { ResumeImport } from "../../../../components/resume-import";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const access = await getAdminAccess();
  if (access.state !== "authorized") redirect("/login");
  const resume = await catalogGet("resumes", id, access.accessToken);
  return (
    <main>
      <header>
        <a className="wordmark" href="/admin">
          Portfolio Admin
        </a>
        <a href="/admin/resume">Back to Resume</a>
      </header>
      <AdminNav />
      <section className="admin-panel catalog-panel">
        <p className="eyebrow">Resume import</p>
        <h1>
          Preview additions<span className="accent">.</span>
        </h1>
        <p className="lead">
          Only selected new items become drafts. Existing content is never
          changed or deleted.
        </p>
        {!resume.ok || resume.data.record.deleted_at ? (
          <p className="content-message">
            Resume unavailable. Restore it or reload before importing.
          </p>
        ) : (
          <ResumeImport resumeId={id} requestId={randomUUID()} />
        )}
      </section>
    </main>
  );
}
