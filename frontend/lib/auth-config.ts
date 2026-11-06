import "server-only";
import { z } from "zod";

export function authConfiguration() {
  const admin = z.uuid().safeParse(process.env.ADMIN_USER_ID);
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (
      !admin.success ||
      !key?.startsWith("sb_publishable_") ||
      url.protocol !== "https:" ||
      url.username ||
      url.password
    )
      return null;
    return { url: url.origin, key, adminId: admin.data };
  } catch {
    return null;
  }
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

/** Apply a deadline even to upstream Auth calls. Never cache a session response. */
export const authFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []),
      AbortSignal.timeout(8000),
    ]),
  });
