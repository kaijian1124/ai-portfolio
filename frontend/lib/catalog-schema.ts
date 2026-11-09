import { z } from "zod";
export const resourceSchema = z.enum([
  "projects",
  "skills",
  "experiences",
  "education",
  "resumes",
  "documents",
  "project_assets",
]);
export type Resource = z.infer<typeof resourceSchema>;
export const paths: Record<Resource, string> = {
  projects: "projects",
  skills: "skills",
  experiences: "experience",
  education: "education",
  resumes: "resume",
  documents: "knowledge-base",
  project_assets: "project-images",
};
export const labels: Record<Resource, string> = {
  projects: "Projects",
  skills: "Skills",
  experiences: "Experience",
  education: "Education",
  resumes: "Resume",
  documents: "Knowledge base",
  project_assets: "Project images",
};
export function resourceFromPath(path: string): Resource | null {
  return (
    (Object.keys(paths) as Resource[]).find((key) => paths[key] === path) ??
    null
  );
}
export type FieldSpec = {
  key: string;
  label: string;
  kind?:
    | "text"
    | "textarea"
    | "url"
    | "date"
    | "number"
    | "checkbox"
    | "tags"
    | "project"
    | "status";
  required?: boolean;
  max?: number;
  value?: unknown;
};
const common: FieldSpec[] = [
  { key: "status", label: "Visibility", kind: "status", value: "draft" },
  { key: "sort_order", label: "Display order", kind: "number", value: 0 },
];
export const fields: Record<Resource, FieldSpec[]> = {
  projects: [
    { key: "title", label: "Title", required: true, max: 160 },
    { key: "slug", label: "URL slug", required: true, max: 100 },
    { key: "summary", label: "Summary", kind: "textarea", max: 2000 },
    {
      key: "body_markdown",
      label: "Technical details (Markdown)",
      kind: "textarea",
      max: 60000,
    },
    { key: "category", label: "Category", max: 80 },
    {
      key: "technologies",
      label: "Technologies (comma separated)",
      kind: "tags",
      value: [],
    },
    { key: "github_url", label: "GitHub URL", kind: "url" },
    { key: "demo_url", label: "Live demo URL", kind: "url" },
    {
      key: "is_featured",
      label: "Featured project",
      kind: "checkbox",
      value: false,
    },
    ...common,
  ],
  skills: [
    { key: "name", label: "Skill", required: true, max: 100 },
    { key: "category", label: "Category", max: 80 },
    { key: "description", label: "Description", kind: "textarea", max: 2000 },
    ...common,
  ],
  experiences: [
    { key: "company", label: "Company", required: true, max: 160 },
    { key: "job_title", label: "Job title", required: true, max: 160 },
    { key: "location", label: "Location", max: 120 },
    { key: "started_on", label: "Start date", kind: "date", required: true },
    {
      key: "ended_on",
      label: "End date (blank if ongoing)",
      kind: "date",
      value: null,
    },
    {
      key: "description_markdown",
      label: "Responsibilities and achievements (Markdown)",
      kind: "textarea",
      max: 20000,
    },
    ...common,
  ],
  education: [
    { key: "institution", label: "Institution", required: true, max: 160 },
    { key: "qualification", label: "Qualification", required: true, max: 160 },
    { key: "field_of_study", label: "Field of study", max: 160 },
    { key: "started_on", label: "Start date", kind: "date", required: true },
    {
      key: "ended_on",
      label: "End date (blank if ongoing)",
      kind: "date",
      value: null,
    },
    {
      key: "description_markdown",
      label: "Details (Markdown)",
      kind: "textarea",
      max: 20000,
    },
    ...common,
  ],
  resumes: [
    { key: "title", label: "Resume title", required: true, max: 160 },
    ...common,
  ],
  documents: [
    { key: "title", label: "Document title", required: true, max: 160 },
    {
      key: "project_id",
      label: "Related project",
      kind: "project",
      value: null,
    },
    {
      key: "approved_for_chat",
      label: "Approved for public AI answers",
      kind: "checkbox",
      value: false,
    },
  ],
  project_assets: [
    { key: "alt_text", label: "Image description", max: 500 },
    ...common.map((f) =>
      f.key === "status" ? { ...f, value: "published" } : f,
    ),
  ],
};
export const recordSchema = z
  .object({
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    deleted_at: z.string().nullable(),
  })
  .catchall(z.unknown());
export type CatalogRecord = z.infer<typeof recordSchema>;
export type CatalogState = {
  status: "idle" | "saved" | "invalid" | "conflict" | "denied" | "unavailable";
  message: string;
  record?: CatalogRecord;
};
export const mutationSchema = z
  .object({
    resource: resourceSchema,
    id: z.uuid().nullable(),
    data: z.record(z.string(), z.unknown()),
    expected_revision: z.number().int().nonnegative().nullable(),
    request_id: z.uuid(),
    operation: z.enum(["save", "delete", "restore", "activate"]),
  })
  .strict()
  .refine(
    (v) =>
      v.operation !== "save" ||
      Object.keys(v.data).every((key) =>
        fields[v.resource].some((f) => f.key === key),
      ),
    "Unknown fields",
  );
export function editableData(
  resource: Resource,
  record?: CatalogRecord | null,
): Record<string, unknown> {
  return Object.fromEntries(
    fields[resource].map((f) => [
      f.key,
      record?.[f.key] ??
        f.value ??
        (f.kind === "project" ? null : f.kind === "checkbox" ? false : ""),
    ]),
  );
}
export function recordTitle(record: CatalogRecord): string {
  for (const key of [
    "title",
    "name",
    "company",
    "institution",
    "filename",
    "alt_text",
  ])
    if (typeof record[key] === "string" && record[key])
      return String(record[key]);
  return "Untitled item";
}
