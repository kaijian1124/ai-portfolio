import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseEvents } from "./sse";
import { boundedJson } from "./request-body";
import { backendUrl, backendFetch } from "./backend";
import { publicRows, imageUrl, text } from "./public-data";
import { adminApi, catalogGet, catalogList, catalogMutation } from "./catalog";
import {
  resourceFromPath,
  mutationSchema,
  editableData,
  recordTitle,
} from "./catalog-schema";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixture");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("parses fragmented SSE, heartbeats, multiline JSON and malformed events", () => {
  const part = parseEvents(
    ': heartbeat\r\n\r\nevent: answer\r\ndata: {"text":"TEST"}\r\n\r\nevent: done\ndata: ',
  );
  expect(part.events).toEqual([{ event: "answer", data: { text: "TEST" } }]);
  expect(part.rest).toContain("done");
  expect(parseEvents(part.rest + "{}\n\n").events[0].event).toBe("done");
  expect(parseEvents("data: bad\n\n").events[0].event).toBe("error");
  expect(parseEvents("event: status\n\n").events).toEqual([]);
  expect(parseEvents('data: {\ndata: "a":1}\n\n').events[0].data).toEqual({
    a: 1,
  });
});
it("bounds JSON without trusting content-length", async () => {
  expect(
    await boundedJson(
      new Request("https://test", { method: "POST", body: '{"a":1}' }),
    ),
  ).toEqual({ a: 1 });
  await expect(
    boundedJson(
      new Request("https://test", { method: "POST", body: "x".repeat(10) }),
      5,
    ),
  ).rejects.toThrow("large");
  await expect(boundedJson(new Request("https://test"))).rejects.toThrow(
    "Empty",
  );
  await expect(
    boundedJson(new Request("https://test", { method: "POST", body: "bad" })),
  ).rejects.toThrow();
});
it("restricts backend URLs and disables response caching", async () => {
  expect(backendUrl("/api/v1/admin/me").origin).toBe(
    "https://api.example.test",
  );
  expect(() => backendUrl("//evil.test")).toThrow();
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://user:pass@evil.test");
  expect(() => backendUrl("/api/v1/test")).toThrow();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://localhost:8000");
  expect(backendUrl("/api/v1/test").hostname).toBe("localhost");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  await backendFetch("/api/v1/test", { signal: new AbortController().signal });
  expect(fetch).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({ cache: "no-store" }),
  );
});
it("validates published row responses and image paths", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify([{ id, title: "TEST" }])),
      ),
  );
  expect(
    await publicRows("projects", { slug: "test", offset: 0, limit: 12 }),
  ).toEqual({ ok: true, rows: [{ id, title: "TEST" }] });
  const url = String(vi.mocked(fetch).mock.calls[0][0]);
  expect(url).toContain("slug=eq.test");
  expect(url).not.toContain("secret");
  expect((await publicRows("skills")).ok).toBe(true);
  await publicRows("experiences");
  await publicRows("project_assets", { projectId: id });
  expect(imageUrl(id + "/" + id + ".png")).toContain(
    "/public/portfolio-images/",
  );
  expect(imageUrl("../private.pdf")).toBeNull();
  expect(text({ id, title: "TEST" }, "title")).toBe("TEST");
  expect(text({ id }, "title")).toBe("");
  vi.mocked(fetch).mockResolvedValue(new Response("[]", { status: 503 }));
  expect(await publicRows("education")).toEqual({ ok: false });
  vi.mocked(fetch).mockResolvedValue(new Response('[{"id":"bad"}]'));
  expect(await publicRows("education")).toEqual({ ok: false });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "bad");
  expect(await publicRows("education")).toEqual({ ok: false });
});
it("maps administrative errors without exposing server details", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  for (const [status, reason] of [
    [401, "denied"],
    [403, "denied"],
    [409, "conflict"],
    [422, "invalid"],
    [500, "unavailable"],
  ] as const) {
    fetcher.mockResolvedValue(new Response("secret error", { status }));
    expect(await adminApi("/api/v1/test", "token")).toEqual({
      ok: false,
      reason,
    });
  }
  fetcher.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ record: { id, revision: 1, deleted_at: null } }),
      ),
  );
  expect((await catalogGet("skills", id, "token")).ok).toBe(true);
  expect((await catalogMutation("skills", null, "token", {})).ok).toBe(true);
  await catalogMutation("skills", id, "token", {});
  fetcher.mockResolvedValue(new Response(JSON.stringify({ records: [] })));
  expect((await catalogList("skills", "token", 100, true)).ok).toBe(true);
  fetcher.mockRejectedValue(new Error("network"));
  expect(await adminApi("/api/v1/test", "token")).toEqual({
    ok: false,
    reason: "unavailable",
  });
});
it("allowlists resources and mutation fields", () => {
  expect(resourceFromPath("knowledge-base")).toBe("documents");
  expect(resourceFromPath("users")).toBeNull();
  expect(editableData("projects", null).technologies).toEqual([]);
  expect(
    editableData("skills", { id, revision: 1, deleted_at: null, name: "TEST" })
      .name,
  ).toBe("TEST");
  expect(recordTitle({ id, revision: 1, deleted_at: null })).toBe(
    "Untitled item",
  );
  expect(recordTitle({ id, revision: 1, deleted_at: null, name: "TEST" })).toBe(
    "TEST",
  );
  const input = {
    resource: "skills",
    id: null,
    data: { name: "TEST" },
    expected_revision: null,
    request_id: id,
    operation: "save",
  };
  expect(mutationSchema.safeParse(input).success).toBe(true);
  expect(
    mutationSchema.safeParse({ ...input, data: { role: "admin" } }).success,
  ).toBe(false);
});
