import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { sdk, store } = vi.hoisted(() => ({
  sdk: vi.fn(),
  store: { getAll: vi.fn(), set: vi.fn() },
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: sdk }));
vi.mock("next/headers", () => ({ cookies: async () => store }));
import { createAuthClient } from "./server";
import { authFetch } from "../auth-config";

beforeEach(() => {
  vi.stubEnv("ADMIN_USER_ID", "11111111-1111-4111-8111-111111111111");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_test_fixture",
  );
  store.getAll.mockReturnValue([
    { name: "sb-example-auth-token", value: "test-token" },
  ]);
  sdk.mockReturnValue({ auth: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it("creates request-scoped clients and writes HttpOnly cookies only in writable contexts", async () => {
  await createAuthClient(true);
  const options = sdk.mock.calls[0][2];
  expect(options.cookies.getAll()).toEqual(store.getAll());
  options.cookies.setAll([
    {
      name: "sb-example-auth-token",
      value: "new-token",
      options: { httpOnly: false },
    },
  ]);
  expect(store.set.mock.calls[0][2]).toMatchObject({
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  await createAuthClient();
  sdk.mock.calls[1][2].cookies.setAll([{ name: "a", value: "b", options: {} }]);
  expect(store.set).toHaveBeenCalledTimes(1);
});
it("fails before creating a client if settings are missing", async () => {
  vi.stubEnv("ADMIN_USER_ID", "");
  await expect(createAuthClient()).rejects.toThrow("not configured");
  expect(sdk).not.toHaveBeenCalled();
});
it("auth fetch is uncached and bounded, with or without caller cancellation", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  await authFetch("https://example.test");
  await authFetch("https://example.test", {
    signal: new AbortController().signal,
  });
  for (const call of fetcher.mock.calls) {
    expect(call[1].cache).toBe("no-store");
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  }
});
