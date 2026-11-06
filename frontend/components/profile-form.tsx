"use client";

import { useActionState, useEffect, useState } from "react";
import { saveProfileAction } from "../app/admin/profile/actions";
import type {
  AdminProfile,
  ProfileFields,
  ProfileFormState,
} from "../lib/profile-schema";

const empty: ProfileFields = {
  display_name: "",
  headline: "",
  about_markdown: "",
  location: null,
  public_email: null,
  github_url: null,
  linkedin_url: null,
  status: "draft",
};
const inputs = [
  ["display_name", "Display name", 120],
  ["headline", "Headline", 200],
  ["location", "Location", 120],
  ["public_email", "Public contact email", 254],
  ["github_url", "GitHub URL", 2048],
  ["linkedin_url", "LinkedIn URL", 2048],
] as const;

export function ProfileForm({
  initialProfile,
  initialRequestId,
}: {
  initialProfile: AdminProfile | null;
  initialRequestId: string;
}) {
  const [draft, setDraft] = useState<ProfileFields>(initialProfile ?? empty);
  const [revision, setRevision] = useState<number | null>(
    initialProfile?.revision ?? null,
  );
  const [requestId, setRequestId] = useState(initialRequestId);
  const [dirty, setDirty] = useState(false);
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(
    saveProfileAction,
    { status: "idle", message: "" },
  );
  const blocked = state.status === "conflict" || state.status === "denied";
  const uncertain = state.status === "unavailable";
  const locked = pending || blocked || uncertain;

  useEffect(() => {
    if (state.status === "saved" && state.profile) {
      setDraft(state.profile);
      setRevision(state.profile.revision);
      setRequestId(crypto.randomUUID());
      setDirty(false);
    }
  }, [state]);

  function edit(name: keyof ProfileFields, value: string) {
    setDraft((previous) => ({ ...previous, [name]: value }));
    setDirty(true);
  }
  return (
    <form action={action} className="profile-form" aria-label="Profile editor">
      <input type="hidden" name="expected_revision" value={revision ?? ""} />
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="status" value={draft.status} />
      <div className="form-grid">
        {inputs.map(([name, label, max]) => (
          <div className="form-field" key={name}>
            <label htmlFor={name}>{label}</label>
            <input
              id={name}
              name={name}
              value={draft[name] ?? ""}
              onChange={(event) => edit(name, event.target.value)}
              required={name === "display_name"}
              maxLength={max}
              readOnly={locked}
              type={
                name === "public_email"
                  ? "email"
                  : name.endsWith("_url")
                    ? "url"
                    : "text"
              }
            />
          </div>
        ))}
      </div>
      <div className="form-field">
        <label htmlFor="about_markdown">About me</label>
        <textarea
          id="about_markdown"
          name="about_markdown"
          rows={9}
          maxLength={20000}
          value={draft.about_markdown}
          readOnly={locked}
          onChange={(event) => edit("about_markdown", event.target.value)}
        />
        <p className="field-help">
          Markdown formatting is supported. Raw HTML and embedded images are not
          rendered. Only include information intended for public display.
        </p>
      </div>
      <div className="form-field">
        <label htmlFor="profile-status">Visibility</label>
        <select
          id="profile-status"
          value={draft.status}
          disabled={locked}
          onChange={(event) => edit("status", event.target.value)}
          aria-describedby="visibility-help"
        >
          <option value="draft">Draft — hidden</option>
          <option value="published">Published — public</option>
          <option value="archived">Archived — hidden</option>
        </select>
        <p id="visibility-help" className="field-help">
          Saving as Published makes these fields public. Saving as Draft or
          Archived hides the profile.
        </p>
      </div>
      {!pending && state.message && (
        <p
          role="status"
          className={state.status === "saved" ? "save-success" : "form-error"}
        >
          {state.status === "saved" && dirty
            ? "Unsaved changes."
            : state.message}
        </p>
      )}
      <div className="form-controls">
        <button type="submit" disabled={pending || blocked}>
          {pending ? "Saving…" : uncertain ? "Retry same save" : "Save profile"}
        </button>
        <a href="/admin/profile">Reload latest profile</a>
        <a href="/" target="_blank" rel="noopener noreferrer">
          View public profile ↗
        </a>
      </div>
      {(uncertain || blocked) && (
        <p className="field-help">
          Your input is preserved. Reloading replaces it with the latest
          database version.
        </p>
      )}
    </form>
  );
}
