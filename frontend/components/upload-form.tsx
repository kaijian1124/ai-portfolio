"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { recordTitle, type CatalogRecord } from "../lib/catalog-schema";
export function UploadForm({
  kind,
  projects = [],
  documents = [],
}: {
  kind: "resume" | "knowledge" | "image";
  projects?: CatalogRecord[];
  documents?: CatalogRecord[];
}) {
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const router = useRouter();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (file instanceof File && file.size > 4194304) {
      setMessage("Files must be 4 MB or smaller.");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/upload", {
        method: "POST",
        body: data,
      });
      if (!response.ok) {
        setMessage(
          response.status === 413
            ? "File is too large."
            : response.status === 401
              ? "Sign in again."
              : "Upload failed. Check file type, size, server keys, and storage setup.",
        );
        return;
      }
      const result = await response.json();
      setMessage(
        result.duplicate
          ? "This file is already registered."
          : kind === "knowledge"
            ? "Uploaded. Review the prepared chunks before approving embedding."
            : "Uploaded. Activate a Resume, or publish the related project for an image.",
      );
      form.reset();
      if (kind === "resume" && result.record?.id)
        router.push(`/admin/resume-import/${result.record.id}`);
      else router.refresh();
    } catch {
      setMessage(
        "Upload outcome unconfirmed. Check the list before retrying; content hashes prevent duplicate document registration.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="upload-card">
      <h2>
        {kind === "resume"
          ? "Upload Resume PDF"
          : kind === "image"
            ? "Upload project image"
            : "Upload knowledge document"}
      </h2>
      <input type="hidden" name="kind" value={kind} />
      <div className="form-grid">
        <div className="form-field">
          <label htmlFor="upload-title">
            {kind === "image" ? "Image description" : "Title"}
          </label>
          <input
            id="upload-title"
            name="title"
            required
            maxLength={160}
            disabled={pending}
          />
        </div>
        <div className="form-field">
          <label htmlFor="upload-file">File</label>
          <input
            id="upload-file"
            name="file"
            type="file"
            required
            disabled={pending}
            accept={
              kind === "image"
                ? "image/png,image/jpeg,image/webp"
                : kind === "resume"
                  ? "application/pdf"
                  : ".pdf,.docx,.md"
            }
          />
        </div>
        {kind !== "resume" && (
          <div className="form-field">
            <label htmlFor="upload-project">Related project</label>
            <select
              id="upload-project"
              name="project_id"
              disabled={pending}
              required={kind === "image"}
            >
              <option value="">
                {kind === "image" ? "Choose project" : "No related project"}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {recordTitle(p)}
                </option>
              ))}
            </select>
          </div>
        )}
        {kind === "knowledge" && (
          <div className="form-field">
            <label htmlFor="upload-replace">Replace an existing document</label>
            <select id="upload-replace" name="replace_id" disabled={pending}>
              <option value="">Create a new document</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {recordTitle(d)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <p className="field-help">
        {kind === "image"
          ? "PNG/JPEG/WebP up to 4 MB. Images are public assets; upload only material intended for public display."
          : kind === "resume"
            ? "PDF up to 4 MB. Files stay private; only the active version is publicly downloadable. After upload, text is sent to OpenAI to preview new portfolio drafts; nothing is overwritten or published."
            : "Text PDF, DOCX, or Markdown up to 4 MB and 300 PDF pages. Scanned PDFs require OCR elsewhere. Review the prepared chunks before approving OpenAI embedding. Approve public AI use separately after indexing."}
      </p>
      <button disabled={pending}>{pending ? "Uploading…" : "Upload"}</button>
      {message && (
        <p role="status" className="field-help">
          {message}
        </p>
      )}
    </form>
  );
}
