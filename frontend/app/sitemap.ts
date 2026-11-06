import type { MetadataRoute } from "next";
import { publicRows, text } from "../lib/public-data";
export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!site || !site.startsWith("https://")) return [];
  const base = site.replace(/\/$/, "");
  const projects = await publicRows("projects", { limit: 100 });
  return ["", "/about", "/projects", "/resume", "/chat"]
    .map((path) => ({ url: base + path }))
    .concat(
      projects.ok
        ? projects.rows.map((row) => ({
            url: base + "/projects/" + text(row, "slug"),
          }))
        : [],
    );
}
