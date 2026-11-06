"use client";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { catalogAction, reindexAction } from "../app/admin/catalog-actions";
import {
  editableData,
  fields,
  paths,
  recordTitle,
  type CatalogRecord,
  type CatalogState,
  type Resource,
} from "../lib/catalog-schema";
export function CatalogForm({
  resource,
  initial,
  requestId,
  projects = [],
}: {
  resource: Resource;
  initial: CatalogRecord | null;
  requestId: string;
  projects?: CatalogRecord[];
}) {
  const router = useRouter();
  const [data, setData] = useState(() => editableData(resource, initial));
  const [record, setRecord] = useState(initial);
  const [key, setKey] = useState(requestId);
  const [state, action, pending] = useActionState<CatalogState, FormData>(
    catalogAction,
    { status: "idle", message: "" },
  );
  const uncertain = state.status === "unavailable",
    blocked = state.status === "conflict" || state.status === "denied",
    locked = pending || uncertain || blocked;
  useEffect(() => {
    if (state.status === "saved" && state.record) {
      setRecord(state.record);
      setData(editableData(resource, state.record));
      setKey(crypto.randomUUID());
      if (!initial)
        router.replace(`/admin/${paths[resource]}/${state.record.id}`);
    }
  }, [state, resource, initial, router]);
  const update = (name: string, value: unknown) =>
    setData((previous) => ({ ...previous, [name]: value }));
  return (
    <form action={action} className="profile-form">
      <input
        type="hidden"
        name="payload"
        value={JSON.stringify({
          resource,
          id: record?.id ?? null,
          data: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [
              k,
              fields[resource].some((f) => f.key === k && f.kind === "tags") &&
              typeof v === "string"
                ? v
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
                : v,
            ]),
          ),
          expected_revision: record?.revision ?? null,
          request_id: key,
          operation: "save",
        })}
      />
      <div className="form-grid">
        {fields[resource].map((field) => (
          <div
            className={`form-field ${field.kind === "textarea" ? "wide" : ""}`}
            key={field.key}
          >
            <label htmlFor={field.key}>{field.label}</label>
            {field.kind === "textarea" ? (
              <textarea
                id={field.key}
                rows={field.key === "body_markdown" ? 16 : 6}
                value={String(data[field.key] ?? "")}
                maxLength={field.max}
                readOnly={locked}
                onChange={(e) => update(field.key, e.target.value)}
              />
            ) : field.kind === "checkbox" ? (
              <input
                id={field.key}
                type="checkbox"
                checked={Boolean(data[field.key])}
                disabled={locked}
                onChange={(e) => update(field.key, e.target.checked)}
              />
            ) : field.kind === "status" ? (
              <select
                id={field.key}
                value={String(data[field.key])}
                disabled={locked}
                onChange={(e) => update(field.key, e.target.value)}
              >
                <option value="draft">Draft — hidden</option>
                <option value="published">Published — public</option>
                <option value="archived">Archived — hidden</option>
              </select>
            ) : field.kind === "project" ? (
              <select
                id={field.key}
                value={String(data[field.key] ?? "")}
                disabled={locked}
                onChange={(e) => update(field.key, e.target.value || null)}
              >
                <option value="">No related project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {recordTitle(project)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={field.key}
                type={
                  field.kind === "number"
                    ? "number"
                    : field.kind === "date"
                      ? "date"
                      : field.kind === "url"
                        ? "url"
                        : "text"
                }
                value={
                  field.kind === "tags"
                    ? Array.isArray(data[field.key])
                      ? (data[field.key] as string[]).join(", ")
                      : String(data[field.key] ?? "")
                    : String(data[field.key] ?? "")
                }
                required={field.required}
                maxLength={field.max}
                pattern={
                  field.key === "slug" ? "[a-z0-9]+(-[a-z0-9]+)*" : undefined
                }
                readOnly={locked}
                onChange={(e) =>
                  update(
                    field.key,
                    field.kind === "number"
                      ? Number(e.target.value)
                      : field.kind === "date" && !e.target.value
                        ? null
                        : e.target.value,
                  )
                }
              />
            )}
          </div>
        ))}
      </div>
      {resource === "documents" && (
        <p className="content-message">
          Approval permits the active processed version to be quoted publicly by
          the AI. The original file stays private. Replacement uploads require
          fresh approval.
        </p>
      )}
      {state.message && !pending && (
        <p
          role="status"
          className={state.status === "saved" ? "save-success" : "form-error"}
        >
          {state.message}
        </p>
      )}
      <div className="form-controls">
        <button disabled={pending || blocked}>
          {pending ? "Saving…" : uncertain ? "Retry same save" : "Save changes"}
        </button>
        <a href={`/admin/${paths[resource]}/${record?.id ?? "new"}`}>
          Reload latest
        </a>
        <a href={`/admin/${paths[resource]}`}>Back to list</a>
      </div>
      {(uncertain || blocked) && (
        <p className="field-help">
          Your input is preserved. Reloading discards unsaved text.
        </p>
      )}
    </form>
  );
}
export function CatalogOperation({
  resource,
  record,
  requestId,
  operation,
}: {
  resource: Resource;
  record: CatalogRecord;
  requestId: string;
  operation: "delete" | "restore" | "activate";
}) {
  const [stableKey] = useState(requestId);
  const [state, action, pending] = useActionState<CatalogState, FormData>(
    catalogAction,
    { status: "idle", message: "" },
  );
  const disabled =
    pending || state.status === "saved" || state.status === "conflict";
  return (
    <form action={action} className="inline-operation">
      <input
        type="hidden"
        name="payload"
        value={JSON.stringify({
          resource,
          id: record.id,
          data: {},
          expected_revision: record.revision,
          request_id: stableKey,
          operation,
        })}
      />
      {operation === "delete" && (
        <label className="confirm-delete">
          <input type="checkbox" required disabled={disabled} />
          Confirm move to trash
        </label>
      )}
      <button disabled={disabled}>
        {pending
          ? "Working…"
          : state.status === "unavailable"
            ? "Retry same request"
            : operation === "delete"
              ? "Move to trash"
              : operation === "restore"
                ? "Restore draft"
                : "Activate Resume"}
      </button>
      {state.message && (
        <p role="status" className="field-help">
          {state.message}
        </p>
      )}
    </form>
  );
}
export function ReindexForm({
  id,
  requestId,
}: {
  id: string;
  requestId: string;
}) {
  const [stableKey] = useState(requestId);
  const [state, action, pending] = useActionState<CatalogState, FormData>(
    reindexAction,
    { status: "idle", message: "" },
  );
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="request_id" value={stableKey} />
      <button disabled={pending || state.status === "saved"}>
        {pending ? "Queueing…" : "Re-index document"}
      </button>
      {state.message && (
        <p role="status" className="field-help">
          {state.message}
        </p>
      )}
    </form>
  );
}
