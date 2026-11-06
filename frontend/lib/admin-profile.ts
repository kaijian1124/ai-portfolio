import "server-only";
import { z } from "zod";
import {
  profileRecordSchema,
  type AdminProfile,
  type SaveProfilePayload,
} from "./profile-schema";

type Failure = {
  status: "error";
  reason: "denied" | "conflict" | "invalid" | "unavailable";
};
export type ProfileReadResult =
  { status: "ok"; profile: AdminProfile | null } | Failure;
export type ProfileSaveResult =
  { status: "ok"; profile: AdminProfile } | Failure;
const responseSchema = z.object({ profile: profileRecordSchema.nullable() });

async function requestProfile(
  token: string,
  payload?: SaveProfilePayload,
): Promise<ProfileReadResult> {
  try {
    const base = new URL(process.env.NEXT_PUBLIC_API_BASE_URL ?? "");
    const local =
      process.env.NODE_ENV !== "production" &&
      base.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(base.hostname);
    if (
      (!local && base.protocol !== "https:") ||
      base.username ||
      base.password
    )
      return { status: "error", reason: "unavailable" };
    const response = await fetch(new URL("/api/v1/admin/profile", base), {
      method: payload ? "PUT" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401 || response.status === 403)
      return { status: "error", reason: "denied" };
    if (response.status === 409) return { status: "error", reason: "conflict" };
    if (response.status === 422) return { status: "error", reason: "invalid" };
    if (!response.ok) return { status: "error", reason: "unavailable" };
    const parsed = responseSchema.safeParse(await response.json());
    return parsed.success
      ? { status: "ok", profile: parsed.data.profile }
      : { status: "error", reason: "unavailable" };
  } catch {
    return { status: "error", reason: "unavailable" };
  }
}

export function readAdminProfile(token: string): Promise<ProfileReadResult> {
  return requestProfile(token);
}
export async function saveAdminProfile(
  token: string,
  payload: SaveProfilePayload,
): Promise<ProfileSaveResult> {
  const result = await requestProfile(token, payload);
  if (result.status === "error") return result;
  return result.profile
    ? { status: "ok", profile: result.profile }
    : { status: "error", reason: "unavailable" };
}
