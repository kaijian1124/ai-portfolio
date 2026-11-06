import { z } from "zod";
import { safeExternalUrl } from "./public-links";

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || null : value),
    z.string().max(max).nullable(),
  );
const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || null : value),
  z
    .string()
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    .nullable(),
);
const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || null : value),
  z
    .string()
    .max(2048)
    .refine((value) => safeExternalUrl(value) !== null)
    .nullable(),
);
export const profileFieldsSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120),
    headline: z.string().max(200),
    about_markdown: z.string().max(20000),
    location: optionalText(120),
    public_email: optionalEmail,
    github_url: optionalUrl,
    linkedin_url: optionalUrl,
    status: z.enum(["draft", "published", "archived"]),
  })
  .strict();
export const profileRecordSchema = profileFieldsSchema
  .extend({
    id: z.uuid(),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sort_order: z.number().int(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .strip();
export const profileSaveSchema = z
  .object({
    profile: profileFieldsSchema,
    expected_revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    request_id: z.uuid(),
  })
  .strict();
export type ProfileFields = z.infer<typeof profileFieldsSchema>;
export type AdminProfile = z.infer<typeof profileRecordSchema>;
export type SaveProfilePayload = z.infer<typeof profileSaveSchema>;
export type ProfileFormState = {
  status: "idle" | "saved" | "invalid" | "conflict" | "denied" | "unavailable";
  message: string;
  profile?: AdminProfile;
};
export const profileFieldNames = [
  "display_name",
  "headline",
  "about_markdown",
  "location",
  "public_email",
  "github_url",
  "linkedin_url",
  "status",
] as const;
