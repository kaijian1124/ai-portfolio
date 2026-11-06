import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { createClient, getUser, getSession, signInWithPassword, signOut } =
  vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    getSession: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  }));
vi.mock("./supabase/server", () => ({ createAuthClient: createClient }));
import { getAdminAccess, signInAdmin } from "./admin-session";
import { authConfiguration, authCookieOptions } from "./auth-config";

const ADMIN = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.stubEnv("ADMIN_USER_ID", ADMIN);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_test_fixture",
  );
  createClient.mockResolvedValue({
    auth: { getUser, getSession, signInWithPassword, signOut },
  });
  getUser.mockResolvedValue({ data: { user: { id: ADMIN } }, error: null });
  getSession.mockResolvedValue({
    data: { session: { access_token: "test-token" } },
    error: null,
  });
  signInWithPassword.mockResolvedValue({
    data: { user: { id: ADMIN } },
    error: null,
  });
  signOut.mockResolvedValue({ error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("authorizes a remotely verified administrator before reading the raw token", async () => {
  expect(await getAdminAccess()).toEqual({
    state: "authorized",
    userId: ADMIN,
    accessToken: "test-token",
  });
  expect(getUser.mock.invocationCallOrder[0]).toBeLessThan(
    getSession.mock.invocationCallOrder[0],
  );
});
it("does not trust a session when verification fails", async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
  expect(await getAdminAccess()).toEqual({ state: "unauthenticated" });
  expect(getSession).not.toHaveBeenCalled();
});
it("rejects a user-editable admin claim", async () => {
  getUser.mockResolvedValue({
    data: { user: { id: "other", user_metadata: { role: "admin" } } },
    error: null,
  });
  expect(await getAdminAccess()).toEqual({ state: "forbidden" });
  expect(getSession).not.toHaveBeenCalled();
});
it("rejects anonymous identities", async () => {
  getUser.mockResolvedValue({
    data: { user: { id: ADMIN, is_anonymous: true } },
    error: null,
  });
  expect(await getAdminAccess()).toEqual({ state: "forbidden" });
});
it("handles unavailable auth service without exposing details", async () => {
  getUser.mockRejectedValue(new Error("private provider error"));
  expect(await getAdminAccess()).toEqual({ state: "unavailable" });
});
it("handles upstream auth errors and missing session tokens", async () => {
  getUser.mockResolvedValueOnce({
    data: { user: null },
    error: { status: 503 },
  });
  expect(await getAdminAccess()).toEqual({ state: "unavailable" });
  getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
  expect(await getAdminAccess()).toEqual({ state: "unauthenticated" });
});
it("fails closed when administrator configuration is missing", async () => {
  vi.stubEnv("ADMIN_USER_ID", "");
  expect(authConfiguration()).toBeNull();
  expect(await getAdminAccess()).toEqual({ state: "unavailable" });
  expect(createClient).not.toHaveBeenCalled();
});
it.each([
  "http://example.supabase.co",
  "invalid",
  "https://user:pass@example.supabase.co",
])("rejects bad URL %s", (url) => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
  expect(authConfiguration()).toBeNull();
});
it("rejects elevated keys", () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_secret_wrong_key");
  expect(authConfiguration()).toBeNull();
});
it("sets HttpOnly cookies and enables Secure in production", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(authCookieOptions()).toEqual({
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
  vi.stubEnv("NODE_ENV", "development");
  expect(authCookieOptions().secure).toBe(false);
});
it("signs in only the configured administrator", async () => {
  expect(await signInAdmin("admin@example.test", "test-password")).toBe("ok");
  expect(createClient).toHaveBeenCalledWith(true);
});
it("clears a non-admin login session", async () => {
  signInWithPassword.mockResolvedValue({
    data: { user: { id: "other" } },
    error: null,
  });
  expect(await signInAdmin("other@example.test", "test-password")).toBe(
    "forbidden",
  );
  expect(signOut).toHaveBeenCalledWith({ scope: "local" });
});
it("reports invalid credentials generically", async () => {
  signInWithPassword.mockResolvedValue({
    data: { user: null },
    error: { status: 400 },
  });
  expect(await signInAdmin("admin@example.test", "wrong-password")).toBe(
    "invalid",
  );
});
it("handles login failure and missing config", async () => {
  signInWithPassword.mockRejectedValue(new Error("private failure"));
  expect(await signInAdmin("admin@example.test", "test-password")).toBe(
    "unavailable",
  );
  vi.stubEnv("ADMIN_USER_ID", "");
  expect(await signInAdmin("admin@example.test", "test-password")).toBe(
    "unavailable",
  );
});
