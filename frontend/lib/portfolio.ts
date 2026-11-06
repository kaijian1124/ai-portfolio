import "server-only";
import { z } from "zod";

const profileSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  headline: z.string(),
  about_markdown: z.string(),
  public_email: z.string().nullable().default(null),
  github_url: z.string().nullable().default(null),
  linkedin_url: z.string().nullable().default(null),
  location: z.string().nullable(),
});
const projectSchema = z.object({
  id: z.uuid(),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: z.string(),
  summary: z.string(),
  github_url: z.string().nullable(),
  demo_url: z.string().nullable(),
  is_featured: z.boolean(),
});

export type PublicProfile = z.infer<typeof profileSchema>;
export type PublicProject = z.infer<typeof projectSchema>;
export type ContentResult<T> =
  | { status: "ok"; data: T }
  | { status: "error"; reason: "configuration" | "unavailable" };

async function readRows<T>(
  table: "profiles" | "projects",
  schema: z.ZodType<T>,
  columns: string,
  order: string,
  limit: number,
): Promise<ContentResult<T[]>> {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  let url: URL;
  try {
    url = new URL(baseUrl ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !key?.startsWith("sb_publishable_")
    ) {
      return { status: "error", reason: "configuration" };
    }
  } catch {
    return { status: "error", reason: "configuration" };
  }
  url = new URL(`/rest/v1/${table}`, url);
  url.search = new URLSearchParams({
    select: columns,
    status: "eq.published",
    order,
    limit: String(limit),
  }).toString();
  try {
    const response = await fetch(url, {
      headers: { apikey: key!, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { status: "error", reason: "unavailable" };
    const parsed = z.array(schema).safeParse(await response.json());
    if (!parsed.success) return { status: "error", reason: "unavailable" };
    return { status: "ok", data: parsed.data };
  } catch {
    // Do not expose provider errors, transport details, or credentials to rendered output.
    return { status: "error", reason: "unavailable" };
  }
}

export async function getPublicProfile(): Promise<
  ContentResult<PublicProfile | null>
> {
  const result = await readRows(
    "profiles",
    profileSchema,
    "id,display_name,headline,about_markdown,public_email,github_url,linkedin_url,location",
    "id.asc",
    1,
  );
  if (result.status === "error") return result;
  return { status: "ok", data: result.data[0] ?? null };
}

export function getPublicProjects(): Promise<ContentResult<PublicProject[]>> {
  return readRows(
    "projects",
    projectSchema,
    "id,slug,title,summary,github_url,demo_url,is_featured",
    "is_featured.desc,sort_order.asc,id.asc",
    50,
  );
}
