import "server-only";
import { authConfiguration } from "./auth-config";
import { createAuthClient } from "./supabase/server";

export type AdminAccess =
  | { state: "authorized"; userId: string; accessToken: string }
  | { state: "unauthenticated" | "forbidden" | "unavailable" };

export async function getAdminAccess(): Promise<AdminAccess> {
  const config = authConfiguration();
  if (!config) return { state: "unavailable" };
  try {
    const client = await createAuthClient();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user)
      return {
        state:
          error?.status && error.status >= 500
            ? "unavailable"
            : "unauthenticated",
      };
    if (data.user.id !== config.adminId || data.user.is_anonymous)
      return { state: "forbidden" };
    // getSession is used ONLY to forward a raw token after getUser verified identity.
    const session = await client.auth.getSession();
    if (session.error || !session.data.session?.access_token)
      return { state: "unauthenticated" };
    return {
      state: "authorized",
      userId: data.user.id,
      accessToken: session.data.session.access_token,
    };
  } catch {
    return { state: "unavailable" };
  }
}

export async function signInAdmin(
  email: string,
  password: string,
): Promise<"ok" | "invalid" | "forbidden" | "unavailable"> {
  const config = authConfiguration();
  if (!config) return "unavailable";
  try {
    const client = await createAuthClient(true);
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.user)
      return error?.status && error.status >= 500 ? "unavailable" : "invalid";
    if (data.user.id !== config.adminId || data.user.is_anonymous) {
      await client.auth.signOut({ scope: "local" });
      return "forbidden";
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}
