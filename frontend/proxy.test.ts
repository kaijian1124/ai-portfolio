import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
const { sdk, claims } = vi.hoisted(() => ({ sdk: vi.fn(), claims: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: sdk }));
import { proxy } from "./proxy";

beforeEach(() => {
  vi.stubEnv("ADMIN_USER_ID", "11111111-1111-4111-8111-111111111111");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_fixture");
  sdk.mockReturnValue({ auth: { getClaims: claims } }); claims.mockResolvedValue({ data: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it("marks admin responses private even without configuration", async () => {
  vi.stubEnv("ADMIN_USER_ID", "");
  const response = await proxy(new NextRequest("http://localhost:3000/admin"));
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(sdk).not.toHaveBeenCalled();
});
it("forwards refreshed cookies to request and response with secure flags", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const request = new NextRequest("https://portfolio.example/admin", { headers: { Cookie: "existing=value" } });
  claims.mockImplementation(async () => {
    const options = sdk.mock.calls[0][2];
    expect(options.cookies.getAll()).toContainEqual({ name: "existing", value: "value" });
    options.cookies.setAll([{ name: "sb-example-auth-token.0", value: "first", options: {} }]);
    options.cookies.setAll([{ name: "sb-example-auth-token.1", value: "second", options: {} }]);
  });
  const response = await proxy(request);
  expect(request.cookies.get("sb-example-auth-token.0")?.value).toBe("first");
  expect(response.cookies.get("sb-example-auth-token.0")?.value).toBe("first");
  expect(response.cookies.get("sb-example-auth-token.1")?.value).toBe("second");
  expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  expect(response.headers.get("set-cookie")).toMatch(/Secure/i);
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("lets page-level verification handle refresh failure without exposing details", async () => {
  claims.mockRejectedValue(new Error("private network details"));
  const response = await proxy(new NextRequest("http://localhost:3000/login"));
  expect(response.headers.get("cache-control")).toContain("no-store");
});
