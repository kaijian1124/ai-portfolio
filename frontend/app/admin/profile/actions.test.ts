import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { access, save, revalidate } = vi.hoisted(() => ({
  access: vi.fn(),
  save: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("../../../lib/admin-session", () => ({ getAdminAccess: access }));
vi.mock("../../../lib/admin-profile", () => ({ saveAdminProfile: save }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));
import { saveProfileAction } from "./actions";
const fields = {
  display_name: "TEST ONLY",
  headline: "Test",
  about_markdown: "About",
  location: "",
  public_email: "",
  github_url: "",
  linkedin_url: "",
  status: "draft",
};
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  data.set("expected_revision", "0");
  data.set("request_id", "22222222-2222-4222-8222-222222222222");
  return data;
}
beforeEach(() =>
  access.mockResolvedValue({
    state: "authorized",
    userId: "test-admin",
    accessToken: "test-token",
  }),
);
afterEach(() => vi.resetAllMocks());
it("rechecks administrator identity on every save", async () => {
  access.mockResolvedValue({ state: "unauthenticated" });
  expect(
    (await saveProfileAction({ status: "idle", message: "" }, form())).status,
  ).toBe("denied");
  expect(save).not.toHaveBeenCalled();
});
it("does not call API for invalid input", async () => {
  const data = form();
  data.set("display_name", " ");
  expect(
    (await saveProfileAction({ status: "idle", message: "" }, data)).status,
  ).toBe("invalid");
  expect(save).not.toHaveBeenCalled();
});
it("reports confirmed saves and refreshes public content", async () => {
  const profile = { ...fields, revision: 1 };
  save.mockResolvedValue({ status: "ok", profile });
  const result = await saveProfileAction(
    { status: "idle", message: "" },
    form(),
  );
  expect(result.status).toBe("saved");
  expect(result.profile).toEqual(profile);
  expect(save.mock.calls[0][0]).toBe("test-token");
  expect(revalidate).toHaveBeenCalledWith("/");
});
it.each(["conflict", "invalid", "denied", "unavailable"])(
  "preserves %s failure state",
  async (reason) => {
    save.mockResolvedValue({ status: "error", reason });
    expect(
      (await saveProfileAction({ status: "idle", message: "" }, form())).status,
    ).toBe(reason);
    expect(revalidate).not.toHaveBeenCalled();
  },
);
