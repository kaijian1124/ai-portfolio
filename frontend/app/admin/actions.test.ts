import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { signIn, createClient, signOut, cookieStore } = vi.hoisted(() => ({
  signIn: vi.fn(),
  createClient: vi.fn(),
  signOut: vi.fn(),
  cookieStore: { getAll: vi.fn(), set: vi.fn() },
}));
vi.mock("../../lib/admin-session", () => ({ signInAdmin: signIn }));
vi.mock("../../lib/supabase/server", () => ({
  createAuthClient: createClient,
}));
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
import { signInAction, signOutAction } from "./actions";
function form(email = "admin@example.test", password = "test-password") {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}
beforeEach(() => {
  signIn.mockResolvedValue("ok");
  createClient.mockResolvedValue({ auth: { signOut } });
  signOut.mockResolvedValue({ error: null });
  cookieStore.getAll.mockReturnValue([]);
});
afterEach(() => vi.resetAllMocks());
it("validates credentials before calling Supabase", async () => {
  expect(
    (await signInAction({ error: "" }, form("invalid", ""))).error,
  ).toContain("valid email");
  expect(signIn).not.toHaveBeenCalled();
});
it.each(["invalid", "forbidden", "unavailable"])(
  "reports %s without echoing credentials",
  async (state) => {
    signIn.mockResolvedValue(state);
    const result = await signInAction({ error: "" }, form());
    expect(result.error).not.toBe("");
    expect(result.error).not.toContain("test-password");
  },
);
it("uses a fixed redirect after successful sign in", async () => {
  await expect(signInAction({ error: "" }, form())).rejects.toThrow(
    "REDIRECT:/admin",
  );
});
it("signs out only the current session and clears auth cookie chunks", async () => {
  cookieStore.getAll.mockReturnValue([
    { name: "sb-example-auth-token.0" },
    { name: "sb-example-auth-token.1" },
    { name: "unrelated" },
  ]);
  await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");
  expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(cookieStore.set).toHaveBeenCalledTimes(2);
  expect(cookieStore.set.mock.calls[0][2]).toMatchObject({
    httpOnly: true,
    maxAge: 0,
  });
});
it("clears this browser session even when remote signout fails", async () => {
  createClient.mockRejectedValue(new Error("offline"));
  cookieStore.getAll.mockReturnValue([{ name: "sb-example-auth-token" }]);
  await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");
  expect(cookieStore.set).toHaveBeenCalledTimes(1);
});
