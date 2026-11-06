"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signInAdmin } from "../../lib/admin-session";
import { createAuthClient } from "../../lib/supabase/server";
import { authCookieOptions } from "../../lib/auth-config";

export type LoginState = { error: string };
const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
});

export async function signInAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success)
    return { error: "Enter a valid email address and password." };
  const result = await signInAdmin(parsed.data.email, parsed.data.password);
  if (result === "invalid")
    return { error: "Unable to sign in with those credentials." };
  if (result === "forbidden")
    return { error: "This account does not have administrator access." };
  if (result === "unavailable")
    return { error: "Sign-in is temporarily unavailable. Please try again." };
  redirect("/admin");
}

export async function signOutAction(): Promise<void> {
  try {
    await (await createAuthClient(true)).auth.signOut({ scope: "local" });
  } catch {
    /* Clear this browser session even when the Auth service is unreachable. */
  }
  const store = await cookies();
  for (const { name } of store.getAll()) {
    if (/^sb-[a-z0-9-]+-auth-token(?:\.\d+)?$/.test(name)) {
      store.set(name, "", { ...authCookieOptions(), maxAge: 0 });
    }
  }
  redirect("/login");
}
