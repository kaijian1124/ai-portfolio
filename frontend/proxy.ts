import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  authConfiguration,
  authCookieOptions,
  authFetch,
} from "./lib/auth-config";

// Session refresh only. Every page/action and FastAPI endpoint authorizes independently.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const config = authConfiguration();
  if (config) {
    const client = createServerClient(config.url, config.key, {
      cookieOptions: authCookieOptions(),
      global: { fetch: authFetch },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (values) => {
          for (const { name, value } of values)
            request.cookies.set(name, value);
          const previousCookies = response.cookies.getAll();
          response = NextResponse.next({ request });
          for (const cookie of previousCookies) response.cookies.set(cookie);
          for (const { name, value, options } of values) {
            response.cookies.set(name, value, {
              ...options,
              ...authCookieOptions(),
            });
          }
        },
      },
    });
    try {
      await client.auth.getClaims();
    } catch {
      /* Page-level verification fails closed. */
    }
  }
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/login", "/api/admin/:path*"],
};
