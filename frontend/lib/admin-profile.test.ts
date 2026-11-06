import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readAdminProfile, saveAdminProfile } from "./admin-profile";
import { profileSaveSchema } from "./profile-schema";
const fields = {
  display_name: "TEST ONLY",
  headline: "Test",
  about_markdown: "Test about",
  location: null,
  public_email: null,
  github_url: null,
  linkedin_url: null,
  status: "draft" as const,
};
const profile = {
  ...fields,
  id: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const payload = {
  profile: fields,
  expected_revision: 0,
  request_id: "22222222-2222-4222-8222-222222222222",
};
const fetcher = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it("loads private profile with an uncached server-to-server token", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ profile })));
  expect(await readAdminProfile("test-token")).toEqual({
    status: "ok",
    profile,
  });
  const [url, init] = fetcher.mock.calls[0];
  expect(url.pathname).toBe("/api/v1/admin/profile");
  expect(init.method).toBe("GET");
  expect(init.headers.Authorization).toBe("Bearer test-token");
  expect(init.cache).toBe("no-store");
});
it("accepts an empty profile only for reads", async () => {
  fetcher.mockImplementation(() =>
    Promise.resolve(new Response('{"profile":null}')),
  );
  expect(await readAdminProfile("test-token")).toEqual({
    status: "ok",
    profile: null,
  });
  expect(await saveAdminProfile("test-token", payload)).toEqual({
    status: "error",
    reason: "unavailable",
  });
});
it("forwards the exact version and idempotency key, without auto-retrying", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ profile })));
  expect((await saveAdminProfile("test-token", payload)).status).toBe("ok");
  const init = fetcher.mock.calls[0][1];
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual(payload);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  [401, "denied"],
  [403, "denied"],
  [409, "conflict"],
  [422, "invalid"],
  [500, "unavailable"],
])("maps HTTP %s without leaking provider detail", async (status, reason) => {
  fetcher.mockResolvedValue(
    new Response("private SQL", { status: Number(status) }),
  );
  expect(await saveAdminProfile("test-token", payload)).toEqual({
    status: "error",
    reason,
  });
});
it("does not report malformed responses or network errors as saved", async () => {
  for (const value of ['{"profile":{}}', "not JSON"]) {
    fetcher.mockResolvedValueOnce(new Response(value));
    expect((await saveAdminProfile("test-token", payload)).status).toBe(
      "error",
    );
  }
  fetcher.mockRejectedValueOnce(new Error("timeout"));
  expect(await saveAdminProfile("test-token", payload)).toEqual({
    status: "error",
    reason: "unavailable",
  });
});
it("never sends tokens to insecure remote URLs", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://api.example.test");
  expect((await readAdminProfile("test-token")).status).toBe("error");
  expect(fetcher).not.toHaveBeenCalled();
});
it("normalizes optional blanks and rejects unsafe or unknown input", () => {
  const parsed = profileSaveSchema.parse({
    ...payload,
    profile: { ...fields, location: " " },
  });
  expect(parsed.profile.location).toBeNull();
  for (const input of [
    { ...payload, profile: { ...fields, display_name: " " } },
    { ...payload, profile: { ...fields, public_email: "bad email" } },
    { ...payload, profile: { ...fields, github_url: "javascript:alert(1)" } },
    { ...payload, profile: { ...fields, role: "admin" } },
    { ...payload, expected_revision: -1 },
    { ...payload, request_id: "invalid" },
  ])
    expect(profileSaveSchema.safeParse(input).success).toBe(false);
});
