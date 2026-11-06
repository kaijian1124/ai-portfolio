import { beforeEach, afterEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock("../../../lib/public-data", () => ({
  publicRows: mocks.rows,
  text: (row: Record<string, unknown>, key: string) =>
    typeof row[key] === "string" ? row[key] : "",
}));
import { GET } from "./route";
const path =
  "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_fixture");
  mocks.rows.mockResolvedValue({ ok: true, rows: [{ storage_path: path }] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("only signs current public metadata and returns a noncached short-lived redirect", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response('{"signedURL":"/storage/v1/object/sign/file?token=TEST"}'),
      ),
  );
  const response = await GET();
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toContain(
    "https://example.supabase.co/storage/",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.rows).toHaveBeenCalledWith("resumes", { limit: 1 });
  const init = vi.mocked(fetch).mock.calls[0][1];
  expect(JSON.parse(init?.body as string)).toEqual({ expiresIn: 60 });
  expect(JSON.stringify(init)).not.toContain("NEXT_PUBLIC_SUPABASE_SECRET");
});
it("fails closed without metadata, private key, valid path or trusted storage response", async () => {
  mocks.rows.mockResolvedValue({ ok: false });
  expect((await GET()).status).toBe(503);
  mocks.rows.mockResolvedValue({ ok: true, rows: [] });
  expect((await GET()).status).toBe(404);
  mocks.rows.mockResolvedValue({
    ok: true,
    rows: [{ storage_path: "../private" }],
  });
  expect((await GET()).status).toBe(503);
  mocks.rows.mockResolvedValue({ ok: true, rows: [{ storage_path: path }] });
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  expect((await GET()).status).toBe(503);
  vi.stubEnv("SUPABASE_SECRET_KEY", "eyJfixture");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response('{"signedURL":"https://evil.test/file"}'),
      ),
  );
  expect((await GET()).status).toBe(503);
  vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 500 }));
  expect((await GET()).status).toBe(503);
});
