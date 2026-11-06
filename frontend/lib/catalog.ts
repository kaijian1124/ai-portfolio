import "server-only";
import { z } from "zod";
import { backendFetch } from "./backend";
import { recordSchema, type Resource } from "./catalog-schema";
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "invalid" | "conflict" | "denied" | "unavailable" };
export async function adminApi<T>(
  path: string,
  token: string,
  init: RequestInit = {},
  schema?: z.ZodType<T>,
): Promise<ApiResult<T>> {
  try {
    const response = await backendFetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok)
      return {
        ok: false,
        reason:
          response.status === 409
            ? "conflict"
            : response.status === 422
              ? "invalid"
              : [401, 403].includes(response.status)
                ? "denied"
                : "unavailable",
      };
    const value = await response.json();
    return { ok: true, data: schema ? schema.parse(value) : value };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
export function catalogList(
  resource: Resource,
  token: string,
  offset = 0,
  includeDeleted = false,
) {
  return adminApi(
    `/api/v1/admin/catalog/${resource}?offset=${offset}&include_deleted=${includeDeleted}`,
    token,
    {},
    z.object({ records: z.array(recordSchema) }),
  );
}
export function catalogGet(resource: Resource, id: string, token: string) {
  return adminApi(
    `/api/v1/admin/catalog/${resource}/${id}`,
    token,
    {},
    z.object({ record: recordSchema }),
  );
}
export function catalogMutation(
  resource: Resource,
  id: string | null,
  token: string,
  body: unknown,
) {
  return adminApi(
    `/api/v1/admin/catalog/${resource}${id ? `?record_id=${id}` : ""}`,
    token,
    { method: "POST", body: JSON.stringify(body) },
    z.object({ record: recordSchema }),
  );
}
