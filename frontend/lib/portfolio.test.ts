import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getPublicProfile, getPublicProjects } from "./portfolio";

const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  display_name: "TEST ONLY",
  headline: "Test headline",
  about_markdown: "Test about",
  public_email: null,
  github_url: null,
  linkedin_url: null,
  location: null,
};
const project = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "test-project",
  title: "TEST ONLY",
  summary: "Test",
  github_url: null,
  demo_url: null,
  is_featured: false,
};
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_test_fixture",
  );
  fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("public content reads", () => {
  it("reads the published profile with explicit columns and no cache", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify([profile])));
    expect(await getPublicProfile()).toEqual({ status: "ok", data: profile });
    const [url, init] = fetcher.mock.calls[0];
    expect(url.pathname).toBe("/rest/v1/profiles");
    expect(url.searchParams.get("status")).toBe("eq.published");
    expect(url.searchParams.get("select")).not.toContain("*");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({
      apikey: "sb_publishable_test_fixture",
      Accept: "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("accepts an empty profile without inventing one", async () => {
    fetcher.mockResolvedValue(new Response("[]"));
    expect(await getPublicProfile()).toEqual({ status: "ok", data: null });
  });
  it("reads a bounded, deterministically sorted published project list", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify([project])));
    expect(await getPublicProjects()).toEqual({
      status: "ok",
      data: [project],
    });
    const [url] = fetcher.mock.calls[0];
    expect(url.pathname).toBe("/rest/v1/projects");
    expect(url.searchParams.get("status")).toBe("eq.published");
    expect(url.searchParams.get("order")).toBe(
      "is_featured.desc,sort_order.asc,id.asc",
    );
    expect(url.searchParams.get("limit")).toBe("50");
  });
  it("accepts an empty project list", async () => {
    fetcher.mockResolvedValue(new Response("[]"));
    expect(await getPublicProjects()).toEqual({ status: "ok", data: [] });
  });
  it.each([401, 403, 404, 500])(
    "reports HTTP %i as error, never empty content",
    async (status) => {
      fetcher.mockResolvedValue(
        new Response("provider detail must not leak", { status }),
      );
      expect(await getPublicProjects()).toEqual({
        status: "error",
        reason: "unavailable",
      });
    },
  );
  it.each([null, {}, [{ title: "incomplete" }]])(
    "rejects an invalid response shape",
    async (data) => {
      fetcher.mockResolvedValue(new Response(JSON.stringify(data)));
      expect(await getPublicProjects()).toEqual({
        status: "error",
        reason: "unavailable",
      });
    },
  );
  it("handles invalid JSON", async () => {
    fetcher.mockResolvedValue(new Response("not json"));
    expect(await getPublicProfile()).toEqual({
      status: "error",
      reason: "unavailable",
    });
  });
  it("handles network or timeout failures", async () => {
    fetcher.mockRejectedValue(new Error("private transport detail"));
    expect(await getPublicProfile()).toEqual({
      status: "error",
      reason: "unavailable",
    });
  });
  it.each(["", "sb_secret_do_not_use_here"])(
    "rejects a missing or elevated key",
    async (key) => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
      expect(await getPublicProfile()).toEqual({
        status: "error",
        reason: "configuration",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    "",
    "not a url",
    "http://example.supabase.co",
    "https://user:password@example.supabase.co",
  ])("rejects an invalid or insecure URL", async (url) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
    expect(await getPublicProjects()).toEqual({
      status: "error",
      reason: "configuration",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
