import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { checkBackendAdmin } from "./backend-admin";
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
it("forwards the token only server-to-server and verifies the expected identity", async () => {
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ user_id: "test-admin", role: "admin" })),
  );
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe("verified");
  const [url, init] = fetcher.mock.calls[0];
  expect(url.pathname).toBe("/api/v1/admin/me");
  expect(init.headers.Authorization).toBe("Bearer test-token");
  expect(init.cache).toBe("no-store");
});
it.each([401, 403])("reports HTTP %s as denied", async (status) => {
  fetcher.mockResolvedValue(new Response("", { status }));
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe("denied");
});
it("handles offline backend", async () => {
  fetcher.mockRejectedValue(new Error("offline"));
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe(
    "unavailable",
  );
});
it("rejects a mismatched backend identity", async () => {
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ user_id: "other", role: "admin" })),
  );
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe("denied");
});
it("rejects bad responses", async () => {
  fetcher
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValueOnce(new Response("bad JSON"));
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe(
    "unavailable",
  );
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe(
    "unavailable",
  );
});
it("never sends tokens over remote HTTP", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://api.example.test");
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe(
    "unavailable",
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it("allows local HTTP only during development", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://localhost:8000");
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ user_id: "test-admin", role: "admin" })),
  );
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe("verified");
  vi.stubEnv("NODE_ENV", "production");
  expect(await checkBackendAdmin("test-token", "test-admin")).toBe(
    "unavailable",
  );
});
