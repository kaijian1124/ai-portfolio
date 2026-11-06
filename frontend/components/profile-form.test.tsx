// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../app/admin/profile/actions", () => ({ saveProfileAction: save }));
import { ProfileForm } from "./profile-form";

const requestId = "22222222-2222-4222-8222-222222222222";
const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  display_name: "TEST ONLY",
  headline: "Test",
  about_markdown: "About",
  location: null,
  public_email: null,
  github_url: null,
  linkedin_url: null,
  status: "draft" as const,
  revision: 0,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
beforeEach(() =>
  save.mockResolvedValue({
    status: "saved",
    message: "Profile saved.",
    profile: { ...profile, revision: 1 },
  }),
);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("loads existing values and advances version/request ID only after confirmed save", async () => {
  const user = userEvent.setup();
  const { container } = render(
    <ProfileForm initialProfile={profile} initialRequestId={requestId} />,
  );
  expect(
    (screen.getByLabelText("Display name") as HTMLInputElement).value,
  ).toBe("TEST ONLY");
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  await screen.findByText("Profile saved.");
  await waitFor(() =>
    expect(
      (
        container.querySelector(
          '[name="expected_revision"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("1"),
  );
  expect(
    (container.querySelector('[name="request_id"]') as HTMLInputElement).value,
  ).not.toBe(requestId);
});
it("preserves edits and retries exactly the same request after an uncertain result", async () => {
  save.mockResolvedValue({
    status: "unavailable",
    message: "Save outcome unconfirmed.",
  });
  const user = userEvent.setup();
  render(<ProfileForm initialProfile={profile} initialRequestId={requestId} />);
  await user.clear(screen.getByLabelText("Display name"));
  await user.type(screen.getByLabelText("Display name"), "TEST changed");
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  await screen.findByText("Save outcome unconfirmed.");
  expect(
    (screen.getByLabelText("Display name") as HTMLInputElement).readOnly,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Retry same save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const first = save.mock.calls[0][1] as FormData;
  const second = save.mock.calls[1][1] as FormData;
  expect([...second.entries()]).toEqual([...first.entries()]);
  expect(second.get("display_name")).toBe("TEST changed");
});
it("blocks stale saves and offers reload instead of overwriting changes", async () => {
  save.mockResolvedValue({
    status: "conflict",
    message: "A newer version exists.",
  });
  const user = userEvent.setup();
  render(<ProfileForm initialProfile={profile} initialRequestId={requestId} />);
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  await screen.findByText("A newer version exists.");
  expect(
    (screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen
      .getByRole("link", { name: "Reload latest profile" })
      .getAttribute("href"),
  ).toBe("/admin/profile");
});
it("keeps fields editable after a known validation failure", async () => {
  save.mockResolvedValue({ status: "invalid", message: "Check your input." });
  const user = userEvent.setup();
  render(<ProfileForm initialProfile={profile} initialRequestId={requestId} />);
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  await screen.findByText("Check your input.");
  expect(
    (screen.getByLabelText("Display name") as HTMLInputElement).readOnly,
  ).toBe(false);
});
it("supports creation without assuming an existing record", () => {
  const { container } = render(
    <ProfileForm initialProfile={null} initialRequestId={requestId} />,
  );
  expect(
    (screen.getByLabelText("Display name") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (container.querySelector('[name="expected_revision"]') as HTMLInputElement)
      .value,
  ).toBe("");
});
