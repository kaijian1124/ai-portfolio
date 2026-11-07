import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  backend: vi.fn(),
  mutate: vi.fn(),
  api: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("../../lib/admin-session", () => ({ getAdminAccess: mocks.access }));
vi.mock("../../lib/backend", () => ({ backendFetch: mocks.backend }));
vi.mock("../../lib/catalog", () => ({
  catalogMutation: mocks.mutate,
  adminApi: mocks.api,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("server-only", () => ({}));
import { POST as ask } from "./chat/route";
import { POST as feedback } from "./chat/feedback/route";
import { POST as reset } from "./chat/reset/route";
import { POST as resumeImport } from "./admin/resume-import/[id]/route";
import { POST as upload } from "./admin/upload/route";
import { GET as download } from "./admin/files/[resource]/[id]/route";
import { catalogAction, reindexAction } from "../admin/catalog-actions";
const id = "11111111-1111-4111-8111-111111111111",
  idle = { status: "idle" as const, message: "" };
function request(
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return new NextRequest("https://portfolio.test" + path, {
    method: "POST",
    headers: {
      origin: "https://portfolio.test",
      "content-type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body ?? {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CHAT_PROXY_SECRET", "p".repeat(40));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  mocks.access.mockResolvedValue({
    state: "authorized",
    accessToken: "private-jwt",
  });
});
afterEach(() => vi.unstubAllEnvs());
it("rejects cross-origin writes and missing sessions before forwarding", async () => {
  expect(
    (await ask(request("/api/chat", {}, { origin: "https://evil.test" })))
      .status,
  ).toBe(403);
  expect((await feedback(request("/api/chat/feedback"))).status).toBe(403);
  expect(
    (
      await reset(
        request("/api/chat/reset", {}, { origin: "https://evil.test" }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await upload(
        request("/api/admin/upload", {}, { origin: "https://evil.test" }),
      )
    ).status,
  ).toBe(403);
  expect(mocks.backend).not.toHaveBeenCalled();
  vi.stubEnv("CHAT_PROXY_SECRET", "short");
  expect((await ask(request("/api/chat", { question: "TEST" }))).status).toBe(
    503,
  );
});
it("forwards chat cookie alone, strips admin cookies and preserves SSE headers", async () => {
  mocks.backend.mockResolvedValue(
    new Response("event: done\ndata: {}\n\n", {
      headers: { "set-cookie": "portfolio_chat=signed; HttpOnly" },
    }),
  );
  const response = await ask(
    request(
      "/api/chat",
      { question: " TEST " },
      {
        cookie: "portfolio_chat=signed; sb-admin=secret",
        "x-vercel-forwarded-for": "192.0.2.1, 192.0.2.2",
      },
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  const args = mocks.backend.mock.calls[0][1];
  expect(args.headers.Cookie).toBe("portfolio_chat=signed");
  expect(JSON.stringify(args)).not.toContain("sb-admin");
  expect(args.headers["X-Portfolio-Client-IP"]).toBe("192.0.2.1");
  expect(JSON.parse(args.body)).toEqual({ question: "TEST" });
  expect(
    (await ask(request("/api/chat", { question: "TEST", role: "admin" })))
      .status,
  ).toBe(422);
  mocks.backend.mockResolvedValue(new Response("{}", { status: 429 }));
  expect((await ask(request("/api/chat", { question: "TEST" }))).status).toBe(
    429,
  );
  mocks.backend.mockRejectedValue(new Error("secret error"));
  expect((await ask(request("/api/chat", { question: "TEST" }))).status).toBe(
    503,
  );
});
it("scopes feedback and reset to the browser session", async () => {
  mocks.backend.mockResolvedValue(new Response("{}"));
  const headers = { cookie: "portfolio_chat=signed" };
  expect(
    (
      await feedback(
        request("/api/chat/feedback", { message_id: id, vote: 1 }, headers),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await feedback(
        request("/api/chat/feedback", { message_id: id, vote: 0 }, headers),
      )
    ).status,
  ).toBe(503);
  const response = await reset(request("/api/chat/reset"));
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});
it("bounds uploads before parsing and verifies admin authorization", async () => {
  mocks.access.mockResolvedValue({ state: "anonymous" });
  expect((await upload(request("/api/admin/upload"))).status).toBe(401);
  mocks.access.mockResolvedValue({
    state: "authorized",
    accessToken: "private-jwt",
  });
  expect(
    (
      await upload(
        request("/api/admin/upload", {}, { "content-length": "9000000" }),
      )
    ).status,
  ).toBe(413);
  const form = new FormData();
  form.set("file", new File(["TEST"], "test.txt"));
  form.set("kind", "knowledge");
  form.set("title", "TEST");
  form.set("project_id", "");
  form.set("replace_id", "");
  mocks.backend.mockResolvedValue(new Response('{"record":{}}'));
  const response = await upload(
    new NextRequest("https://portfolio.test/api/admin/upload", {
      method: "POST",
      headers: { origin: "https://portfolio.test" },
      body: form,
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.backend.mock.calls[0][1].headers.Authorization).toBe(
    "Bearer private-jwt",
  );
  expect(mocks.backend.mock.calls[0][1].body.has("project_id")).toBe(false);
});
it("private downloads validate identifiers, authentication and destination origin", async () => {
  const req = new NextRequest(
    "https://portfolio.test/api/admin/files/documents/" + id,
  );
  const params = { params: Promise.resolve({ resource: "documents", id }) };
  expect(
    (
      await download(req, {
        params: Promise.resolve({ resource: "users", id }),
      })
    ).status,
  ).toBe(404);
  mocks.access.mockResolvedValue({ state: "anonymous" });
  expect((await download(req, params)).headers.get("location")).toContain(
    "/login",
  );
  mocks.access.mockResolvedValue({ state: "authorized", accessToken: "jwt" });
  mocks.backend.mockResolvedValue(
    new Response('{"url":"https://evil.test/file"}'),
  );
  expect((await download(req, params)).status).toBe(503);
  mocks.backend.mockResolvedValue(
    new Response('{"url":"https://example.supabase.co/file"}'),
  );
  const response = await download(req, params);
  expect(response.status).toBe(307);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
function form(operation = "save") {
  const data = new FormData();
  data.set(
    "payload",
    JSON.stringify({
      resource: "skills",
      id: null,
      data: { name: "TEST" },
      expected_revision: null,
      request_id: id,
      operation,
    }),
  );
  return data;
}
it("catalog actions check auth, retain uncertain outcomes and invalidate public views", async () => {
  mocks.access.mockResolvedValue({ state: "unavailable" });
  expect((await catalogAction(idle, form())).status).toBe("unavailable");
  expect((await reindexAction(idle, new FormData())).status).toBe("denied");
  mocks.access.mockResolvedValue({ state: "authorized", accessToken: "jwt" });
  expect((await catalogAction(idle, new FormData())).status).toBe("invalid");
  for (const reason of ["invalid", "conflict", "denied", "unavailable"]) {
    mocks.mutate.mockResolvedValue({ ok: false, reason });
    expect((await catalogAction(idle, form())).status).toBe(reason);
  }
  for (const operation of ["save", "delete", "restore", "activate"]) {
    mocks.mutate.mockResolvedValue({
      ok: true,
      data: { record: { id, revision: 1, deleted_at: null } },
    });
    expect((await catalogAction(idle, form(operation))).status).toBe("saved");
  }
  expect(mocks.revalidate).toHaveBeenCalledWith("/projects");
  const data = new FormData();
  data.set("id", id);
  data.set("request_id", id);
  mocks.api.mockResolvedValue({ ok: false, reason: "unavailable" });
  expect((await reindexAction(idle, data)).status).toBe("unavailable");
  mocks.api.mockResolvedValue({ ok: true, data: {} });
  expect((await reindexAction(idle, data)).status).toBe("saved");
  expect((await reindexAction(idle, new FormData())).status).toBe("invalid");
});

it("Resume import proxy enforces auth, origin and ID-only confirmation", async () => {
  const params = { params: Promise.resolve({ id }) };
  const path = "/api/admin/resume-import/" + id;
  expect(
    (
      await resumeImport(
        request(path, {}, { origin: "https://evil.test" }),
        params,
      )
    ).status,
  ).toBe(403);
  mocks.access.mockResolvedValue({ state: "anonymous" });
  expect(
    (
      await resumeImport(
        request(path, { action: "analyze", request_id: id }),
        params,
      )
    ).status,
  ).toBe(401);
  mocks.access.mockResolvedValue({
    state: "authorized",
    accessToken: "private-jwt",
  });
  expect(
    (
      await resumeImport(request(path, { action: "analyze", request_id: id }), {
        params: Promise.resolve({ id: "bad" }),
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await resumeImport(
        request(path, {
          action: "apply",
          request_id: id,
          candidate_ids: [id],
          data: { status: "published" },
        }),
        params,
      )
    ).status,
  ).toBe(422);
  mocks.backend.mockResolvedValue(
    new Response('{"status":"completed","candidates":[]}'),
  );
  expect(
    (
      await resumeImport(
        request(path, { action: "analyze", request_id: id }),
        params,
      )
    ).status,
  ).toBe(200);
  expect(JSON.parse(mocks.backend.mock.calls[0][1].body)).toEqual({
    request_id: id,
  });
  mocks.backend.mockResolvedValue(
    new Response('{"status":"applied","created":[],"skipped":1}'),
  );
  expect(
    (
      await resumeImport(
        request(path, { action: "apply", request_id: id, candidate_ids: [id] }),
        params,
      )
    ).status,
  ).toBe(200);
  expect(JSON.parse(mocks.backend.mock.calls[1][1].body)).toEqual({
    candidate_ids: [id],
  });
  mocks.backend.mockResolvedValue(new Response("{}", { status: 429 }));
  expect(
    (
      await resumeImport(
        request(path, { action: "analyze", request_id: id }),
        params,
      )
    ).status,
  ).toBe(429);
  mocks.backend.mockRejectedValue(new Error("private error"));
  expect(
    (
      await resumeImport(
        request(path, { action: "analyze", request_id: id }),
        params,
      )
    ).status,
  ).toBe(503);
});
