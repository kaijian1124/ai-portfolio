import "server-only";
import { z } from "zod";
const tables = {
  projects:
    "id,title,slug,summary,body_markdown,category,technologies,github_url,demo_url,is_featured,updated_at",
  skills: "id,name,category,description",
  experiences:
    "id,company,job_title,location,started_on,ended_on,description_markdown",
  education:
    "id,institution,qualification,field_of_study,started_on,ended_on,description_markdown",
  resumes: "id,title,filename,storage_path,updated_at",
  project_assets: "id,project_id,storage_path,alt_text",
};
export type PublicTable = keyof typeof tables;
export type PublicRow = { id: string; [key: string]: unknown };
export type PublicResult = { ok: true; rows: PublicRow[] } | { ok: false };
export async function publicRows(
  table: PublicTable,
  options: {
    slug?: string;
    projectId?: string;
    offset?: number;
    limit?: number;
  } = {},
): Promise<PublicResult> {
  try {
    const base = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      !key?.startsWith("sb_publishable_")
    )
      return { ok: false };
    const url = new URL(`/rest/v1/${table}`, base);
    url.searchParams.set("select", tables[table]);
    url.searchParams.set(
      "order",
      table === "projects"
        ? "is_featured.desc,sort_order.asc,id.asc"
        : table === "experiences" || table === "education"
          ? "started_on.desc,id.asc"
          : "sort_order.asc,id.asc",
    );
    url.searchParams.set(
      "limit",
      String(Math.max(1, Math.min(options.limit ?? 100, 100))),
    );
    url.searchParams.set(
      "offset",
      String(Math.max(0, Math.min(options.offset ?? 0, 100000))),
    );
    if (options.slug) url.searchParams.set("slug", `eq.${options.slug}`);
    if (options.projectId)
      url.searchParams.set("project_id", `eq.${options.projectId}`);
    const response = await fetch(url, {
      headers: { apikey: key },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false };
    const rows = z
      .array(z.object({ id: z.uuid() }).catchall(z.unknown()))
      .parse(await response.json());
    return { ok: true, rows };
  } catch {
    return { ok: false };
  }
}
export function text(row: PublicRow, key: string) {
  return typeof row[key] === "string" ? (row[key] as string) : "";
}
export function imageUrl(path: string) {
  if (!/^[a-f0-9-]+\/[a-f0-9-]+\.(png|jpg|webp)$/.test(path)) return null;
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/portfolio-images/${path}`;
}
