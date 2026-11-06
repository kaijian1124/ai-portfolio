import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  authConfiguration,
  authCookieOptions,
  authFetch,
} from "../auth-config";

/** New request-scoped client; no shared session and no browser auth client. */
export async function createAuthClient(writable = false) {
  const config = authConfiguration();
  if (!config) throw new Error("Authentication is not configured");
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    cookieOptions: authCookieOptions(),
    global: { fetch: authFetch },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        // Proxy refreshes cookies before Server Components render. Actions can also write.
        if (writable)
          for (const { name, value, options } of values) {
            store.set(name, value, { ...options, ...authCookieOptions() });
          }
      },
    },
  });
}
