"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdminAccess } from "../../lib/admin-session";
import { adminApi, catalogMutation } from "../../lib/catalog";
import {
  mutationSchema,
  paths,
  type CatalogState,
} from "../../lib/catalog-schema";
export async function catalogAction(
  _previous: CatalogState,
  form: FormData,
): Promise<CatalogState> {
  const access = await getAdminAccess();
  if (access.state !== "authorized")
    return {
      status: access.state === "unavailable" ? "unavailable" : "denied",
      message: "Sign in again or retry once the service is ready.",
    };
  let raw: unknown;
  try {
    const value = form.get("payload");
    if (typeof value !== "string" || value.length > 100000) throw new Error();
    raw = JSON.parse(value);
  } catch {
    return { status: "invalid", message: "Invalid form input." };
  }
  const parsed = mutationSchema.safeParse(raw);
  if (!parsed.success)
    return { status: "invalid", message: "Check the form values." };
  const { resource, id, ...body } = parsed.data;
  const result = await catalogMutation(resource, id, access.accessToken, body);
  if (!result.ok) {
    const messages = {
      invalid: "Check required fields, dates, slug and HTTPS links.",
      conflict:
        "Content changed or a unique value is already used. Reload before editing.",
      denied: "Administrator access denied. Sign in again.",
      unavailable:
        "Save outcome unconfirmed. Retry the same request or reload before changing it.",
    };
    return { status: result.reason, message: messages[result.reason] };
  }
  revalidatePath(`/admin/${paths[resource]}`);
  revalidatePath("/");
  revalidatePath("/about");
  revalidatePath("/projects");
  revalidatePath("/resume");
  return {
    status: "saved",
    message:
      body.operation === "delete"
        ? "Moved to trash."
        : body.operation === "restore"
          ? "Restored as a draft."
          : body.operation === "activate"
            ? "Active Resume updated."
            : "Saved.",
    record: result.data.record,
  };
}
export async function approveEmbeddingAction(
  id: string,
  version: string,
  jobId: string,
  hash: string,
  page: number,
  form: FormData,
) {
  const access = await getAdminAccess();
  if (access.state !== "authorized") redirect("/login");
  if (
    ![id, version, jobId].every((value) => z.uuid().safeParse(value).success) ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    !Number.isInteger(page) ||
    page < 1
  ) {
    redirect("/admin/knowledge-base");
  }
  const path = `/admin/document-chunks/${id}/${version}`;
  if (form.get("confirmed") !== "yes")
    redirect(`${path}?page=${page}&approval=failed`);
  const result = await adminApi(
    `/api/v1/admin/documents/${id}/approve-embedding`,
    access.accessToken,
    {
      method: "POST",
      body: JSON.stringify({ job_id: jobId, preview_hash: hash }),
    },
  );
  revalidatePath(path);
  redirect(`${path}?page=${page}&approval=${result.ok ? "queued" : "failed"}`);
}

export async function reindexAction(
  _previous: CatalogState,
  form: FormData,
): Promise<CatalogState> {
  const access = await getAdminAccess();
  if (access.state !== "authorized")
    return { status: "denied", message: "Sign in again." };
  const id = form.get("id"),
    requestId = form.get("request_id");
  if (
    typeof id !== "string" ||
    typeof requestId !== "string" ||
    !(/^[a-f0-9-]{36}$/i.test(id) && /^[a-f0-9-]{36}$/i.test(requestId))
  )
    return { status: "invalid", message: "Invalid document." };
  const result = await adminApi(
    `/api/v1/admin/documents/${id}/reindex`,
    access.accessToken,
    { method: "POST", body: JSON.stringify({ request_id: requestId }) },
  );
  if (!result.ok)
    return {
      status: result.reason,
      message: "Could not confirm the queue request. Retry the same request.",
    };
  revalidatePath("/admin/knowledge-base");
  return {
    status: "saved",
    message:
      "Preparation queued. Review and approve the new chunks before embedding.",
  };
}
